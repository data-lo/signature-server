// Framework & third-party libraries
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Not, Repository } from 'typeorm';

// Entities
import { AccountEntity } from 'src/account/entities/account.entity';
import { RoleEntity } from 'src/roles/entities/role.entity';

// Enums
import { SYSTEM_ROLE_NAME_ENUM } from 'src/roles/enums/system-role-name.enum';

// Services
import { EmailService } from 'src/common/email/email.service';
import { IdempotencyService } from 'src/event/idempotency.service';

// Utilities
import { buildOrganizationMembersUrl } from 'src/account/utils/organization-members-url.util';

import { OrganizationMemberJoinedEventPayload } from '../organization-member.topics';

/** Nombre a mostrar de una persona, con el correo como último recurso. */
const displayName = (
  firstName: string | undefined,
  lastName: string | undefined,
  email: string,
): string => `${firstName ?? ''} ${lastName ?? ''}`.trim() || email;

/**
 * `organization.member.joined`: avisa por correo a los propietarios y administradores de que
 * alguien se incorporó a su organización.
 *
 * Los destinatarios se resuelven AQUÍ y no viajan en el evento, a propósito: entre que la
 * membresía se guarda y el aviso sale puede cambiar quién administra la organización, y quien
 * debe enterarse es quien administra en el momento del envío. Por lo mismo se resuelven también
 * el nombre, el correo y el rol a partir de los ids del sobre.
 *
 * **Nadie se entera dos veces.** La marca de idempotencia se toma por DESTINATARIO
 * (`organization-member-joined:<accountId>`) y no por evento: si el correo de uno falla, se le
 * suelta la marca sólo a él, así que una reentrega del mismo evento reintenta ese envío sin
 * repetir los que ya salieron. Ésa es la forma que toma aquí el "poder reintentarse" que pide la
 * historia, y la razón de que un fallo nunca se propague: la incorporación ya está confirmada en
 * base y no depende de que SendGrid responda.
 */
@Injectable()
export class NotifyOrganizationAdminsOfNewMemberUseCase {
  private readonly logger = new Logger(
    NotifyOrganizationAdminsOfNewMemberUseCase.name,
  );

  /**
   * Prefijo de la marca de idempotencia. Es una constante y no `NotifyOrganizationAdmins...name`:
   * renombrar la clase no debe hacer que se reenvíe todo el pasado.
   */
  private static readonly NOTIFICATION_CLAIM_PREFIX =
    'organization-member-joined';

  constructor(
    @InjectRepository(AccountEntity)
    private readonly accountRepository: Repository<AccountEntity>,

    @InjectRepository(RoleEntity)
    private readonly roleRepository: Repository<RoleEntity>,

    private readonly emailService: EmailService,
    private readonly idempotency: IdempotencyService,
  ) {}

  /**
   * Manda un correo a cada propietario y administrador activo de la organización.
   *
   * @param payload - Sobre de `organization.member.joined`, con los ids de la membresía nueva.
   * @returns Nada.
   *
   * @throws Nada: cualquier fallo se registra y se traga. La incorporación ya ocurrió y no debe
   *   revertirse porque un correo no salga.
   *
   * @example
   * ```ts
   * await notifyOrganizationAdminsOfNewMember.execute(payload);
   * ```
   */
  async execute(payload: OrganizationMemberJoinedEventPayload): Promise<void> {
    this.logger.log(
      `Nuevo miembro en la organización ${payload.organizationId}: membresía ${payload.accountId} (usuario ${payload.memberUserId}) @ ${payload.occurredAt}`,
    );

    try {
      await this.notifyAdministrators(payload);
    } catch (error) {
      this.logger.error(
        `Error notificando el alta de la membresía ${payload.accountId} en la organización ${payload.organizationId}: ${error}`,
      );
    }
  }

  /**
   * Resuelve la membresía recién dada de alta y le manda el aviso a cada administrador.
   *
   * @param payload - Sobre del evento.
   * @returns Nada.
   *
   * @throws {QueryFailedError} Si falla alguna de las consultas; lo atrapa `execute`.
   *
   * @example
   * ```ts
   * await this.notifyAdministrators(payload);
   * ```
   */
  private async notifyAdministrators(
    payload: OrganizationMemberJoinedEventPayload,
  ): Promise<void> {
    const membership = await this.accountRepository.findOne({
      where: { id: payload.accountId },
      relations: { user: true, organization: true, role: true },
    });

    if (!membership?.organization) {
      this.logger.warn(
        `Membresía ${payload.accountId} sin organización al notificar el alta; se descarta el aviso`,
      );
      return;
    }

    const recipients = await this.findAdministrators(
      membership.organization.id,
      payload.memberUserId,
    );

    if (recipients.length === 0) {
      this.logger.log(
        `La organización ${membership.organization.id} no tiene propietarios ni administradores activos a quienes avisar del alta de ${payload.accountId}`,
      );
      return;
    }

    const memberFullName = displayName(
      membership.user?.firstName,
      membership.user?.lastName,
      membership.email,
    );
    const membersUrl = buildOrganizationMembersUrl(membership.organization.id);

    for (const recipient of recipients) {
      await this.notifyOne(payload, recipient, {
        memberFullName,
        memberEmail: membership.user?.email ?? membership.email,
        organizationName: membership.organization.name,
        /**
         * Una membresía puede no tener rol todavía (ver `AccountEntity.roleId`). El aviso se
         * manda igual: el hecho que le importa a quien administra es que hay alguien nuevo
         * dentro, y un rol pendiente es justo lo que querría ir a revisar.
         */
        roleName: membership.role?.name ?? 'Sin rol asignado',
        membersUrl,
      });
    }
  }

  /**
   * Miembros ACTIVOS de la organización con rol de sistema OWNER o ADMIN, sin el recién llegado.
   *
   * Se comparan ids de rol y no `role.name === 'ADMIN'`: una organización puede definir un rol
   * propio con ese mismo nombre (el índice único de `roles` es por `organizationId + name`, ver
   * `RoleEntity`), y darle avisos de administración por llamarse igual sería concederle de facto
   * una visibilidad que nadie le otorgó. Mismo criterio que `assertNotLastAdmin`.
   *
   * La exclusión del recién llegado se hace en la consulta y no al final: es una condición del
   * conjunto de destinatarios, no un caso raro que filtrar después. Aplica aunque él mismo haya
   * quedado con rol OWNER o ADMIN, que es el escenario que la historia señala.
   *
   * @param organizationId - Organización cuyos administradores se buscan.
   * @param joinedUserId - Usuario que se acaba de unir, excluido de los destinatarios.
   * @returns Las membresías a notificar, con su usuario cargado. Vacío si no hay ninguna.
   *
   * @throws {QueryFailedError} Si la consulta contra Postgres falla.
   *
   * @example
   * ```ts
   * const recipients = await this.findAdministrators('org-1', 'user-nuevo');
   * ```
   */
  private async findAdministrators(
    organizationId: string,
    joinedUserId: string,
  ): Promise<AccountEntity[]> {
    const administratorRoles = await this.roleRepository.find({
      where: {
        name: In([SYSTEM_ROLE_NAME_ENUM.OWNER, SYSTEM_ROLE_NAME_ENUM.ADMIN]),
        isSystemRole: true,
      },
    });

    if (administratorRoles.length === 0) {
      this.logger.warn(
        'No hay roles de sistema OWNER/ADMIN sembrados; no hay a quién notificar. Corre "npm run seed:roles".',
      );
      return [];
    }

    return this.accountRepository.find({
      where: {
        organizationId,
        isActive: true,
        roleId: In(administratorRoles.map((role) => role.id)),
        userId: Not(joinedUserId),
      },
      relations: { user: true },
    });
  }

  /**
   * Manda el aviso a UN administrador, una sola vez por mucho que el evento se reentregue.
   *
   * La marca se reclama antes de enviar —igual que en el resto de los consumidores— y se suelta
   * si el envío falla, para que ese destinatario concreto pueda reintentarse sin que los demás
   * reciban el correo dos veces.
   *
   * @param payload - Sobre del evento; su `eventId` es la llave de deduplicación.
   * @param recipient - Membresía del administrador que recibe el aviso.
   * @param content - Datos ya resueltos del nuevo miembro, la organización y el enlace.
   * @returns Nada.
   *
   * @throws Nada: un fallo de SendGrid se registra y suelta la marca del destinatario.
   *
   * @example
   * ```ts
   * await this.notifyOne(payload, recipient, content);
   * ```
   */
  private async notifyOne(
    payload: OrganizationMemberJoinedEventPayload,
    recipient: AccountEntity,
    content: {
      memberFullName: string;
      memberEmail: string;
      organizationName: string;
      roleName: string;
      membersUrl: string;
    },
  ): Promise<void> {
    const claimKey = `${NotifyOrganizationAdminsOfNewMemberUseCase.NOTIFICATION_CLAIM_PREFIX}:${recipient.id}`;

    if (!(await this.idempotency.claim(payload.eventId, claimKey))) return;

    const recipientEmail = recipient.user?.email ?? recipient.email;

    try {
      await this.emailService.sendOrganizationMemberJoinedNotification(
        recipientEmail,
        displayName(
          recipient.user?.firstName,
          recipient.user?.lastName,
          recipientEmail,
        ),
        content.memberFullName,
        content.memberEmail,
        content.organizationName,
        content.roleName,
        content.membersUrl,
      );

      this.logger.log(
        `Aviso de nuevo miembro enviado a ${recipientEmail} (membresía ${payload.accountId}, organización ${payload.organizationId})`,
      );
    } catch (error) {
      await this.idempotency.release(payload.eventId, claimKey);
      this.logger.error(
        `Error enviando a ${recipientEmail} el aviso del alta de la membresía ${payload.accountId}; queda pendiente para la siguiente reentrega del evento ${payload.eventId}: ${error}`,
      );
    }
  }
}
