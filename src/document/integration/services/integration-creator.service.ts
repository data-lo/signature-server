import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, IsNull } from 'typeorm';

import { AccountMemberService } from 'src/account/account-member.service';
import { AccountService } from 'src/account/account.service';
import { AccountEntity } from 'src/account/entities/account.entity';
import { DuplicateOrganizationMembershipException } from 'src/account/exceptions/organization.exceptions';
import { formatPersonName } from 'src/common/utils/format-person-name.util';
import { OrganizationMemberEventsProducer } from 'src/kafka/organization-member.producer';
import { SYSTEM_ROLE_NAME_ENUM } from 'src/roles/enums/system-role-name.enum';
import { RolesService } from 'src/roles/roles.service';
import { UserEntity } from 'src/user/entities/user.entity';
import { USER_LIFECYCLE_STATUS_ENUM } from 'src/user/enums/user-lifecycle-status.enum';
import { UserRoles } from 'src/user/enums/user-roles';

import {
  IntegrationCreatorMembershipRevokedException,
  IntegrationCreatorUnavailableException,
} from '../exceptions/integration-document.exceptions';

/** Quién se pide como creador, y en qué organización. */
export interface ResolveIntegrationCreatorParams {
  /** Organización de la API key. */
  organizationId: string;
  email: string;
  firstName: string;
  lastName: string;
  /** Usuario que emitió la llave: queda como actor del aviso de alta en la organización. */
  actorUserId: string;
}

/** Identidad de una persona a la que se puede aprovisionar un usuario. */
export interface ProvisionalUserIdentity {
  /** Ya normalizado (minúsculas, sin espacios). */
  email: string;
  firstName: string;
  lastName: string;
}

/** El creador ya listo para crear el documento a su nombre. */
export interface ResolvedIntegrationCreator {
  user: UserEntity;
  /** Su membresía activa en la organización de la llave: el `accountId` del documento. */
  account: AccountEntity;
  /** Si en esta petición se creó el usuario (provisional) y/o su membresía. */
  provisioned: { user: boolean; membership: boolean };
}

/** Errores de unicidad que indican que otra petición creó lo mismo a la vez. */
const CONCURRENT_UNIQUE_CONSTRAINTS = ['UQ_97672ac88f789774dd47f7c8be3'];

/**
 * Resuelve —y si hace falta, da de alta— al creador de un documento que llega por la API de
 * integración, identificado exclusivamente por su correo normalizado.
 *
 * - **El usuario existe y es miembro activo de la organización:** se usa su membresía tal cual.
 *   No se toca nada de sus datos, aunque el payload traiga otro nombre.
 * - **El usuario existe sin membresía en la organización:** se le crea una con el rol mínimo
 *   `INTEGRATION_DOCUMENT_CREATOR` (`AccountMemberService.saveMembership`, el mismo alta de
 *   miembros de la plataforma) y se anuncia `organization.member.joined`, que avisa a los
 *   administradores.
 * - **El usuario no existe:** se crea `PROVISIONED` (sólo nombre y correo, sin CURP ni
 *   contraseña), con su cuenta personal y perfil Free (`AccountService.createDefaultPersonalAccount`,
 *   igual que el registro) y la membresía de arriba.
 *
 * Todo eso en UNA transacción, separada de la del documento: si el documento no llega a crearse
 * (por ejemplo, sin créditos), el creador queda dado de alta y el reintento lo reutiliza.
 *
 * Una membresía dada de baja NO se reactiva: alguien de la organización sacó a esa persona, y una
 * integración no debe revertirlo. Tampoco se usa un usuario desactivado o borrado.
 */
@Injectable()
export class IntegrationCreatorService {
  private readonly logger = new Logger(IntegrationCreatorService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly accountService: AccountService,
    private readonly accountMemberService: AccountMemberService,
    private readonly rolesService: RolesService,
    private readonly organizationMemberEventsProducer: OrganizationMemberEventsProducer,
  ) {}

  /**
   * Devuelve el creador con su membresía activa en la organización, creándolos si faltan.
   *
   * @param params - Organización, identidad pedida y actor de la llave.
   * @returns El usuario, su membresía y qué se creó.
   *
   * @throws {IntegrationCreatorUnavailableException} (422) Si el correo es de un usuario
   *   desactivado o borrado.
   * @throws {IntegrationCreatorMembershipRevokedException} (422) Si su membresía en la
   *   organización está dada de baja.
   *
   * @example
   * ```ts
   * const { user, account } = await integrationCreatorService.resolve({
   *   organizationId: 'org-1', email: 'ana@cliente.com', firstName: 'Ana', lastName: 'López', actorUserId: 'user-actor',
   * });
   * ```
   */
  async resolve(
    params: ResolveIntegrationCreatorParams,
  ): Promise<ResolvedIntegrationCreator> {
    const email = params.email.trim().toLowerCase();

    let resolved: ResolvedIntegrationCreator;
    try {
      resolved = await this.dataSource.transaction((manager) =>
        this.resolveWithin(manager, { ...params, email }),
      );
    } catch (error) {
      // Otra petición dio de alta al mismo creador a la vez: lo suyo ya está; se vuelve a leer.
      if (!isConcurrentCreation(error)) throw error;
      resolved = await this.dataSource.transaction((manager) =>
        this.resolveWithin(manager, { ...params, email }),
      );
    }

    await this.afterCommit(resolved);
    return resolved;
  }

  private async resolveWithin(
    manager: EntityManager,
    params: ResolveIntegrationCreatorParams,
  ): Promise<ResolvedIntegrationCreator> {
    let user = await manager
      .getRepository(UserEntity)
      .findOne({ where: { email: params.email } });
    const createdUser = !user;

    if (user && (!user.isActive || user.isDeleted)) {
      throw new IntegrationCreatorUnavailableException();
    }

    if (!user) {
      user = await this.provisionUser(manager, params);
    }

    let membership = await manager.getRepository(AccountEntity).findOne({
      where: { userId: user.id, organizationId: params.organizationId },
    });
    if (membership && !membership.isActive) {
      throw new IntegrationCreatorMembershipRevokedException();
    }

    const createdMembership = !membership;
    if (!membership) {
      const role = await this.rolesService.findSystemRoleByName(
        SYSTEM_ROLE_NAME_ENUM.INTEGRATION_DOCUMENT_CREATOR,
      );
      membership = await this.accountMemberService.saveMembership(
        {
          organizationId: params.organizationId,
          userId: user.id,
          roleId: role.id,
        },
        user,
        manager,
      );
      await this.organizationMemberEventsProducer.enqueueJoined(manager, {
        membership,
        actorUserId: params.actorUserId,
      });
    }

    return {
      user,
      account: membership,
      provisioned: { user: createdUser, membership: createdMembership },
    };
  }

  /**
   * Crea el usuario provisional con su cuenta personal y su perfil Free.
   *
   * @param manager - Transacción en curso.
   * @param params - Identidad pedida, con el correo ya normalizado.
   * @returns El usuario creado, `PROVISIONED` y sin contraseña.
   *
   * @example
   * ```ts
   * const user = await this.provisionUser(manager, params);
   * ```
   */
  /**
   * Cuenta a la que se vincula un firmante de firma simple de un documento creado por integración,
   * para que firme desde `/sign/:token` sin iniciar sesión. Reutiliza el mismo aprovisionamiento
   * que el creador (`provisionUser`): usuario `PROVISIONED` y su cuenta personal.
   *
   * - **El correo no tiene usuario:** se crea `PROVISIONED`; se devuelve su cuenta personal.
   * - **Ya es `PROVISIONED` (activo):** se reutiliza; su cuenta personal.
   * - **Es un usuario `ACTIVE`, inactivo o borrado:** `null`. Un usuario con cuenta firma desde ella,
   *   como siempre, y la invitación no lo vincula por su cuenta.
   *
   * No crea membresía en la organización: el firmante no es miembro, sólo firma.
   *
   * @param manager - Transacción del alta del documento.
   * @param identity - Correo (normalizado), nombre y apellido del firmante.
   * @returns El `accounts.id` personal del usuario provisional, o `null`.
   *
   * @throws {QueryFailedError} (23505) Si otra transacción aprovisionó el mismo correo a la vez; el
   *   alta del documento falla y el cliente la reintenta con su `Idempotency-Key`.
   *
   * @example
   * ```ts
   * const accountId = await creators.resolveProvisionalSigner(manager, { email: 'beto@acme.mx', firstName: 'Beto', lastName: 'Ruiz' });
   * ```
   */
  async resolveProvisionalSigner(
    manager: EntityManager,
    identity: ProvisionalUserIdentity,
  ): Promise<string | null> {
    let user = await manager
      .getRepository(UserEntity)
      .findOne({ where: { email: identity.email } });

    if (!user) {
      user = await this.provisionUser(manager, identity);
    } else if (
      user.lifecycleStatus !== USER_LIFECYCLE_STATUS_ENUM.PROVISIONED ||
      !user.isActive ||
      user.isDeleted
    ) {
      return null;
    }

    const personal = await manager.getRepository(AccountEntity).findOne({
      where: { userId: user.id, organizationId: IsNull() },
      select: { id: true },
    });
    return personal?.id ?? null;
  }

  private async provisionUser(
    manager: EntityManager,
    params: ProvisionalUserIdentity,
  ): Promise<UserEntity> {
    const user = await manager.getRepository(UserEntity).save(
      manager.getRepository(UserEntity).create({
        firstName: formatPersonName(params.firstName),
        lastName: formatPersonName(params.lastName),
        email: params.email,
        roles: [UserRoles.SIGNER],
        lifecycleStatus: USER_LIFECYCLE_STATUS_ENUM.PROVISIONED,
        nationalId: null,
        password: null,
        personalInformationId: null,
        isEmailVerified: false,
      }),
    );

    await this.accountService.createDefaultPersonalAccount(
      manager,
      user.id,
      user.email,
      null,
    );

    return user;
  }

  /**
   * Lo que va después del commit, best-effort como en el alta de miembros: publicar el aviso de
   * alta y sumar las cuentas nuevas al catálogo de Redis de la persona.
   *
   * @param resolved - Resultado de la transacción.
   * @returns Nada.
   *
   * @example
   * ```ts
   * await this.afterCommit(resolved);
   * ```
   */
  private async afterCommit(
    resolved: ResolvedIntegrationCreator,
  ): Promise<void> {
    if (!resolved.provisioned.membership) return;

    try {
      await this.organizationMemberEventsProducer.flushOutbox();
    } catch (error) {
      this.logger.error(
        `No se pudo publicar el alta del creador ${resolved.user.id}; queda en la outbox: ${error}`,
      );
    }

    const accounts = await this.dataSource.getRepository(AccountEntity).find({
      where: { userId: resolved.user.id },
      relations: { organization: true },
    });
    for (const account of accounts) {
      const isNew =
        account.id === resolved.account.id ||
        (resolved.provisioned.user && account.organizationId === null);
      if (isNew) {
        await this.accountService.appendAccountToCatalog(
          resolved.user.id,
          account,
        );
      }
    }
  }
}

/**
 * Reconoce que otra petición creó a la vez el mismo usuario o la misma membresía.
 *
 * @param error - Lo que lanzó la transacción.
 * @returns `true` si es el choque contra la unicidad de `users.email` o la de membresías.
 *
 * @example
 * ```ts
 * if (isConcurrentCreation(error)) { … }
 * ```
 */
function isConcurrentCreation(error: unknown): boolean {
  if (error instanceof DuplicateOrganizationMembershipException) return true;

  const driverError = (error as { driverError?: Record<string, unknown> })
    ?.driverError;
  return (
    driverError?.code === '23505' &&
    (CONCURRENT_UNIQUE_CONSTRAINTS.includes(driverError.constraint as string) ||
      String(driverError.detail ?? '').includes('(email)'))
  );
}
