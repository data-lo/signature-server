import {
  ConflictException,
  GoneException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { randomUUID } from 'crypto';
import { OrganizationInvitationEntity } from './entities/organization-invitation.entity';
import { AccountEntity } from './entities/account.entity';
import { OrganizationEntity } from './entities/organization.entity';
import { UserEntity } from 'src/user/entities/user.entity';
import { AccountService } from './account.service';
import { INVITATION_STATUS_ENUM } from './enums/invitation-status.enum';
import { ACCOUNT_TYPE_ENUM } from './enums/account-type.enum';
import { ACCOUNT_STATUS_ENUM } from './enums/account-status.enum';
import { OrganizationInvitationEventsProducer } from 'src/kafka/organization-invitation.producer';
import { isDuplicateMembershipError } from './exceptions/organization.exceptions';

const INVITATION_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000; // 7 días — sin precedente en el repo, valor razonable para un enlace de invitación por correo.

interface CreateInvitationParams {
  organizationId: string;
  roleId: string;
  invitedBy: string;
  email: string;
}

/**
 * Historia [STORY] Eventos Kafka, Email (SendGrid) y Miembros (/join). El token de la
 * invitación ES la credencial de autorización de `acceptByRfc` — se acepta sin JWT a propósito
 * (el invitado puede no tener sesión iniciada todavía, ver Escenario 5 de la historia). La
 * identidad se resuelve por RFC, no por igualdad de email contra la invitación: el correo al
 * que se mandó la invitación es solo el canal de entrega, no necesariamente el email con el que
 * la persona ya tiene cuenta en la plataforma (decisión explícita del flujo de la historia, no
 * un descuido). Nota de seguridad: cualquiera que conozca el token (del correo) Y el RFC del
 * invitado (dato semi-público en México) puede consumar la invitación — es el tradeoff que la
 * propia historia especifica al no exigir contraseña en este paso.
 */
@Injectable()
export class OrganizationInvitationService {
  constructor(
    @InjectRepository(OrganizationInvitationEntity)
    private readonly invitationRepository: Repository<OrganizationInvitationEntity>,

    @InjectRepository(AccountEntity)
    private readonly accountRepository: Repository<AccountEntity>,

    @InjectRepository(OrganizationEntity)
    private readonly organizationRepository: Repository<OrganizationEntity>,

    @InjectRepository(UserEntity)
    private readonly userRepository: Repository<UserEntity>,

    private readonly accountService: AccountService,
    private readonly invitationEventsProducer: OrganizationInvitationEventsProducer,
  ) {}

  async create(params: CreateInvitationParams): Promise<void> {
    const organization = await this.organizationRepository.findOne({
      where: { id: params.organizationId },
    });
    if (!organization) {
      throw new NotFoundException(
        `Organización con ID ${params.organizationId} no encontrada`,
      );
    }

    const token = randomUUID();
    const expiresAt = new Date(Date.now() + INVITATION_EXPIRY_MS);
    const email = params.email.toLowerCase();

    await this.invitationRepository.save(
      this.invitationRepository.create({
        organizationId: params.organizationId,
        roleId: params.roleId,
        invitedBy: params.invitedBy,
        email,
        token,
        status: INVITATION_STATUS_ENUM.PENDING,
        expiresAt,
      }),
    );

    this.invitationEventsProducer.emitInvited({
      email,
      organizationId: params.organizationId,
      organizationName: organization.name,
      roleId: params.roleId,
      invitationToken: token,
      invitedBy: params.invitedBy,
    });
  }

  /** Usuario dueño de ese RFC, exigiendo que exista. El RFC se guarda en mayúsculas. */
  async findUserByRfcOrFail(rfc: string): Promise<UserEntity> {
    const user = await this.userRepository.findOne({
      where: { personalInformation: { rfc: rfc.toUpperCase() } },
      relations: { personalInformation: true },
    });

    if (!user) {
      throw new NotFoundException(
        'No existe ningún usuario registrado con ese RFC',
      );
    }

    return user;
  }

  /**
   * Consuma una invitación para la persona dueña de ese RFC: el ÚNICO camino por el que alguien
   * se une a una organización desde una invitación.
   *
   * Sirve a los dos casos del flujo de `/join` con el mismo código: quien ya tenía cuenta, y
   * quien la acaba de crear — el frontend lo llama justo después de que el registro respondió
   * bien. El registro ya no acepta la invitación por su cuenta: mantenerlo independiente es lo
   * que permite que un fallo aquí no toque la cuenta recién creada, y que la persona pueda unirse
   * después con una invitación nueva.
   *
   * **La identidad se resuelve por RFC y NO se compara el correo de la invitación con el del
   * usuario.** El correo al que se mandó el enlace es sólo el canal de entrega: la persona puede
   * tener su cuenta registrada con otro correo (el personal, por ejemplo).
   *
   * @param token - Token de la invitación, tal como viaja en el enlace del correo.
   * @param rfc - RFC con el que la persona se identifica; se compara en mayúsculas.
   * @returns Nada: la membresía queda creada y la invitación en `ACCEPTED`.
   *
   * @throws {NotFoundException} (404) Si el token no existe, o si no hay usuario con ese RFC.
   * @throws {ConflictException} (409) Si la invitación ya se usó, o la persona ya es miembro
   *   activo de esa organización.
   * @throws {GoneException} (410) Si la invitación expiró.
   *
   * @example
   * ```ts
   * await organizationInvitationService.acceptByRfc(token, 'XAXX010101000');
   * ```
   */
  async acceptByRfc(token: string, rfc: string): Promise<void> {
    const invitation = await this.resolveInvitation(token);
    this.assertPending(invitation);

    const user = await this.findUserByRfcOrFail(rfc);

    await this.finalizeAcceptance(invitation, user);
  }

  async finalizeAcceptance(
    invitation: OrganizationInvitationEntity,
    user: UserEntity,
  ): Promise<void> {
    const existingMembership = await this.accountRepository.findOne({
      where: {
        organizationId: invitation.organizationId,
        userId: user.id,
        isActive: true,
      },
    });
    if (existingMembership) {
      throw new ConflictException('Ya eres miembro de esta organización');
    }

    /**
     * La comprobación de arriba lee y esto escribe: dos aceptaciones simultáneas del mismo enlace
     * pasan las dos. La segunda choca contra el índice único de `accounts` y sale con el mismo
     * 409 que habría dado la comprobación, en vez de con un error de Postgres.
     */
    const account = await this.saveMembershipOrConflict(invitation, user);
    account.organization = invitation.organization;

    invitation.status = INVITATION_STATUS_ENUM.ACCEPTED;
    await this.invitationRepository.save(invitation);

    await this.accountService.appendAccountToCatalog(user.id, account);
  }

  /**
   * Inserta la membresía de quien acepta la invitación, traduciendo el duplicado a un 409.
   *
   * @param invitation - Invitación que se está consumando.
   * @param user - Usuario que se une, resuelto por RFC.
   * @returns La membresía guardada.
   *
   * @throws {ConflictException} (409) Si esa persona ya tiene membresía en la organización.
   *
   * @example
   * ```ts
   * const account = await this.saveMembershipOrConflict(invitation, user);
   * ```
   */
  private async saveMembershipOrConflict(
    invitation: OrganizationInvitationEntity,
    user: UserEntity,
  ): Promise<AccountEntity> {
    try {
      return await this.accountRepository.save(
        this.accountRepository.create({
          userId: user.id,
          accountType: ACCOUNT_TYPE_ENUM.ORGANIZATION,
          organizationId: invitation.organizationId,
          roleId: invitation.roleId,
          isActive: true,
          status: ACCOUNT_STATUS_ENUM.ACTIVE,
          email: user.email,
          password: user.password,
          joinedAt: new Date(),
        }),
      );
    } catch (error) {
      if (isDuplicateMembershipError(error)) {
        throw new ConflictException('Ya eres miembro de esta organización');
      }
      throw error;
    }
  }

  /** Expiración perezosa: se marca EXPIRED en el primer acceso posterior a expiresAt, no vía job programado (sin infraestructura de cron en este repo). */
  async resolveInvitation(
    token: string,
  ): Promise<OrganizationInvitationEntity> {
    const invitation = await this.invitationRepository.findOne({
      where: { token },
      relations: { organization: true },
    });
    if (!invitation) {
      throw new NotFoundException('Invitación no encontrada');
    }

    if (
      invitation.status === INVITATION_STATUS_ENUM.PENDING &&
      invitation.expiresAt.getTime() < Date.now()
    ) {
      invitation.status = INVITATION_STATUS_ENUM.EXPIRED;
      await this.invitationRepository.save(invitation);
    }

    return invitation;
  }

  /**
   * Exige que la invitación siga `PENDING`, con un error distinto para cada motivo.
   *
   * Cualquier estado que no sea `PENDING` se rechaza, no sólo los dos que hoy existen además de
   * él: un estado nuevo (una invitación revocada, por ejemplo) no debe poder aceptarse por no
   * haberse agregado aquí.
   *
   * @param invitation - Invitación ya resuelta por `resolveInvitation`, con la expiración aplicada.
   * @returns Nada: autorizar es no lanzar.
   *
   * @throws {ConflictException} (409) Si ya se usó, o si está en cualquier otro estado no pendiente.
   * @throws {GoneException} (410) Si expiró.
   *
   * @example
   * ```ts
   * this.assertPending(invitation);
   * ```
   */
  assertPending(invitation: OrganizationInvitationEntity): void {
    if (invitation.status === INVITATION_STATUS_ENUM.PENDING) return;

    if (invitation.status === INVITATION_STATUS_ENUM.EXPIRED) {
      throw new GoneException('Esta invitación ya expiró');
    }
    throw new ConflictException('Esta invitación ya fue utilizada');
  }
}
