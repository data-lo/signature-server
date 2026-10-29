import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { createHash } from 'crypto';
import { DataSource, EntityManager } from 'typeorm';

import { AccountService } from 'src/account/account.service';
import { AccountEntity } from 'src/account/entities/account.entity';
import { ApiKeyEntity } from 'src/api-key/entities/api-key.entity';
import { IssuePlatformApiKeyUseCase } from 'src/api-key/applications/issue-platform-api-key.use-case';
import { CreditLotEntity } from 'src/billing/credits/credit-lot.entity';
import { BillingProfileProvisioningService } from 'src/billing/profiles/billing-profile-provisioning.service';
import { BillingProfileEntity } from 'src/billing/profiles/billing-profile.entity';
import { toBillingOwner } from 'src/billing/profiles/billing-owner.util';
import { RegisterManualSubscriptionBillingUseCase } from 'src/billing/subscriptions/register-manual-subscription-billing.use-case';
import { BaseResponse } from 'src/interfaces/api-response.dto';
import { PermissionEntity } from 'src/roles/entities/permission.entity';
import { RoleEntity } from 'src/roles/entities/role.entity';
import { SYSTEM_ROLE_NAME_ENUM } from 'src/roles/enums/system-role-name.enum';
import { RolesService } from 'src/roles/roles.service';
import { UserEntity } from 'src/user/entities/user.entity';

import { DEFAULT_INTEGRATION_PERMISSION_KEYS } from '../constants/default-integration-permissions';
import {
  DEFAULT_PROVISIONED_DOCUMENTS_GRANTED,
  PROVISIONED_PERIOD_AMOUNT,
  PROVISIONED_PERIOD_CURRENCY,
  PROVISIONED_PLAN_DOCUMENTS_INCLUDED,
  PROVISIONED_PLAN_NAME,
  PROVISIONED_PLAN_TYPE,
} from '../constants/provisioning-billing.constants';
import { ProvisionProvisionalEnterpriseAccountDto } from '../dto/provision-provisional-enterprise-account.dto';
import { PlatformProvisioningRequestEntity } from '../entities/platform-provisioning-request.entity';
import {
  ConcurrentProvisioningException,
  ProvisioningExternalReferenceAlreadyUsedException,
  ProvisioningIdempotencyKeyMismatchException,
  ProvisioningInvalidBillingPeriodException,
} from '../exceptions/platform-provisioning.exceptions';
import { ProvisionedEnterpriseAccountData } from '../interfaces/provision-provisional-enterprise-account-response';
import {
  ProvisionalOwner,
  ProvisionalOwnerProvisioningService,
} from '../services/provisional-owner-provisioning.service';

/**
 * Espacio del bloqueo asesor (`pg_advisory_xact_lock(namespace, hashtext(clave))`) que serializa
 * las peticiones con el mismo `Idempotency-Key`. Es el número de la migración que creó la tabla:
 * basta con que no lo use otro bloqueo asesor del proyecto.
 */
export const PROVISIONING_ADVISORY_LOCK_NAMESPACE = 1784300086;

/** Lo que llega del controller, ya autenticado y validado. */
export interface ProvisionProvisionalEnterpriseAccountCommand {
  dto: ProvisionProvisionalEnterpriseAccountDto;
  /** Header `Idempotency-Key`, ya validado. */
  idempotencyKey: string;
}

/** Lo que se creó dentro de la transacción, para lo que va después del commit. */
interface CreatedProvisioning {
  kind: 'CREATED';
  data: ProvisionedEnterpriseAccountData;
  owner: ProvisionalOwner;
  membership: AccountEntity;
}

/**
 * `POST /api/v1/internal/organizations/provision`: crea en UNA operación una cuenta provisional
 * lista para probar la firma documental por API.
 *
 * ```
 * Usuario PROVISIONED → cuenta personal → organización → membresía OWNER
 *   → perfil de facturación MANUAL → periodo enterprise con N créditos → API key fma_live_*
 * ```
 *
 * **Todo en una transacción.** Si cualquier paso falla —el correo es de un usuario registrado, el
 * folio ya existe, el pepper de las llaves no está configurado— no queda nada: ni usuario, ni
 * organización, ni créditos, ni llave. Lo único fuera es el refresco del catálogo de Redis, que es
 * un cache y no debe deshacer una cuenta ya creada.
 *
 * **Idempotente por `Idempotency-Key`.** Las peticiones con la misma clave se serializan con un
 * bloqueo asesor de la transacción; la que llega después de una confirmada encuentra su fila en
 * `platform_provisioning_requests` y responde con lo ya creado (`replayed: true`) sin duplicar
 * organización, créditos ni llaves. Como el secreto de la llave no se guarda en claro, la repetición
 * devuelve `apiKey: null`. La misma clave con otros datos es 409.
 *
 * Lo que decide el backend y no el request: plan `enterprise` (que habilita `API_INTEGRATION`),
 * importe 0 en `mxn`, origen `MANUAL`, y el perfil de permisos de la llave
 * (`DEFAULT_INTEGRATION_PERMISSION_KEYS`). La llave nace sin emisor (`createdByAccountId = null`).
 * No hay ninguna llamada a Stripe, ni CAPTCHA, ni OTP, ni contraseña.
 *
 * **El secreto de la llave no se registra**: ni en logs ni en la fila de idempotencia; sólo viaja en
 * la respuesta.
 */
@Injectable()
export class ProvisionProvisionalEnterpriseAccountUseCase {
  private readonly logger = new Logger(
    ProvisionProvisionalEnterpriseAccountUseCase.name,
  );

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly ownerProvisioning: ProvisionalOwnerProvisioningService,
    private readonly accountService: AccountService,
    private readonly rolesService: RolesService,
    private readonly billingProfileProvisioning: BillingProfileProvisioningService,
    private readonly registerManualSubscriptionBilling: RegisterManualSubscriptionBillingUseCase,
    private readonly issuePlatformApiKey: IssuePlatformApiKeyUseCase,
  ) {}

  /**
   * Aprovisiona la cuenta, o responde con la que ya creó esa misma clave.
   *
   * @param command - Body validado y `Idempotency-Key`.
   * @returns Los identificadores de todo lo creado y la llave completa (`null` en una repetición).
   *
   * @throws {ProvisioningInvalidBillingPeriodException} (422) Si el periodo no termina después de
   *   empezar.
   * @throws {ProvisioningIdempotencyKeyMismatchException} (409) Si la clave ya se usó con otros
   *   datos.
   * @throws {ProvisioningExternalReferenceAlreadyUsedException} (409) Si el folio ya está
   *   registrado en otro periodo manual.
   * @throws {ProvisionalOwnerEmailAlreadyRegisteredException} (409) Si el correo es de un usuario
   *   registrado (`ACTIVE`).
   * @throws {ProvisionalOwnerUnavailableException} (409) Si el correo es de un usuario desactivado.
   * @throws {ConcurrentProvisioningException} (409) Si otra petición creó lo mismo a la vez.
   * @throws {ApiKeyPermissionNotFoundException} (422) Si el catálogo de permisos no está sembrado.
   * @throws {ApiKeyNotConfiguredException} (500) Si falta `INTEGRATION_API_KEY_HMAC_SECRET`.
   * @throws {InternalServerErrorException} (500) Si el rol OWNER no está sembrado.
   *
   * @example
   * ```ts
   * const { data } = await provisionAccount.execute({ dto, idempotencyKey: 'prov-acme-001' });
   * data.apiKey; // 'fma_live_…'
   * data.creditsAvailable; // 1600
   * ```
   */
  async execute(
    command: ProvisionProvisionalEnterpriseAccountCommand,
  ): Promise<BaseResponse<ProvisionedEnterpriseAccountData>> {
    const { dto, idempotencyKey } = command;
    if (dto.billing.periodEnd.getTime() <= dto.billing.periodStart.getTime()) {
      throw new ProvisioningInvalidBillingPeriodException();
    }
    const requestHash = buildProvisioningRequestHash(dto);

    // Lo que puede fallar sin escribir nada va antes de abrir la transacción.
    const ownerRole = await this.rolesService.findSystemRoleByName(
      SYSTEM_ROLE_NAME_ENUM.OWNER,
    );
    const permissions = await this.issuePlatformApiKey.resolvePermissionProfile(
      DEFAULT_INTEGRATION_PERMISSION_KEYS,
    );

    let outcome:
      | CreatedProvisioning
      | { kind: 'REPLAY'; data: ProvisionedEnterpriseAccountData };
    try {
      outcome = await this.dataSource.transaction(async (manager) => {
        await manager.query(
          'SELECT pg_advisory_xact_lock($1::int, hashtext($2))',
          [PROVISIONING_ADVISORY_LOCK_NAMESPACE, idempotencyKey],
        );

        const replay = await this.findReplay(
          manager,
          idempotencyKey,
          requestHash,
        );
        if (replay) {
          return { kind: 'REPLAY' as const, data: replay };
        }

        return this.provisionWithin(manager, {
          dto,
          idempotencyKey,
          requestHash,
          ownerRole,
          permissions,
        });
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConcurrentProvisioningException();
      }
      throw error;
    }

    if (outcome.kind === 'REPLAY') {
      return {
        success: true,
        message:
          'La cuenta provisional ya se había aprovisionado con este Idempotency-Key',
        data: outcome.data,
      };
    }

    await this.publishToCatalog(outcome);
    this.logger.log(
      `Cuenta provisional Enterprise aprovisionada: organización ${outcome.data.organizationId}, ` +
        `perfil ${outcome.data.billingProfileId} con ${outcome.data.documentsGranted} crédito(s), ` +
        `API key ${outcome.data.apiKeyId} (${outcome.data.apiKeyPrefix}).`,
    );

    return {
      success: true,
      message: 'Cuenta provisional aprovisionada correctamente',
      data: outcome.data,
    };
  }

  /**
   * Los pasos que escriben, en orden, dentro de la transacción ya bloqueada por la clave.
   *
   * @param manager - Transacción en curso.
   * @param params - Body, clave, huella, rol OWNER y perfil de permisos ya resueltos.
   * @returns Lo creado, con la llave completa.
   *
   * @throws Cualquiera de las excepciones de `execute` que se dan dentro de la transacción; al
   *   lanzarse, la transacción se revierte entera.
   *
   * @example
   * ```ts
   * const created = await this.provisionWithin(manager, params);
   * ```
   */
  private async provisionWithin(
    manager: EntityManager,
    params: {
      dto: ProvisionProvisionalEnterpriseAccountDto;
      idempotencyKey: string;
      requestHash: string;
      ownerRole: RoleEntity;
      permissions: PermissionEntity[];
    },
  ): Promise<CreatedProvisioning> {
    const { dto } = params;
    const documentsGranted =
      dto.billing.documentsGranted ?? DEFAULT_PROVISIONED_DOCUMENTS_GRANTED;

    if (
      await this.registerManualSubscriptionBilling.findByExternalReference(
        manager,
        dto.billing.externalReference,
      )
    ) {
      throw new ProvisioningExternalReferenceAlreadyUsedException();
    }

    const owner = await this.ownerProvisioning.resolve(manager, {
      email: dto.owner.email,
      firstName: dto.owner.firstName,
      lastName: dto.owner.lastName,
    });

    const membership =
      await this.accountService.saveOrganizationWithOwnerAccountWithin(
        manager,
        owner.user,
        {
          name: dto.organization.name,
          organizationName: dto.organization.organizationName,
          taxId: dto.organization.taxId,
          domainAllowed: dto.organization.domainAllowed,
        },
        params.ownerRole,
      );

    await this.billingProfileProvisioning.ensureManualPlanExists(manager, {
      planType: PROVISIONED_PLAN_TYPE,
      name: PROVISIONED_PLAN_NAME,
      documentsIncluded: PROVISIONED_PLAN_DOCUMENTS_INCLUDED,
    });
    const profile = await this.billingProfileProvisioning.createManualProfile(
      manager,
      toBillingOwner(membership),
    );
    await this.registerManualSubscriptionBilling.executeWithin(manager, {
      billingProfileId: profile.id,
      planType: PROVISIONED_PLAN_TYPE,
      amount: PROVISIONED_PERIOD_AMOUNT,
      currency: PROVISIONED_PERIOD_CURRENCY,
      periodStart: dto.billing.periodStart,
      periodEnd: dto.billing.periodEnd,
      documentsGranted,
      externalReference: dto.billing.externalReference,
      createdByUserId: null,
      notes:
        'Cuenta provisional Enterprise creada por el aprovisionamiento interno de plataforma',
    });

    const issued = await this.issuePlatformApiKey.issueWithin(manager, {
      organizationId: membership.organizationId,
      name: dto.apiKeyName,
      permissions: params.permissions,
    });

    await manager.getRepository(PlatformProvisioningRequestEntity).insert({
      idempotencyKey: params.idempotencyKey,
      requestHash: params.requestHash,
      organizationId: membership.organizationId,
      organizationAccountId: membership.id,
      ownerUserId: owner.user.id,
      ownerAccountId: owner.personalAccount.id,
      billingProfileId: profile.id,
      apiKeyId: issued.id,
      documentsGranted,
    });

    return {
      kind: 'CREATED',
      owner,
      membership,
      data: {
        organizationId: membership.organizationId,
        organizationAccountId: membership.id,
        ownerUserId: owner.user.id,
        ownerAccountId: owner.personalAccount.id,
        ownerLifecycleStatus: owner.user.lifecycleStatus,
        ownerRole: params.ownerRole.name,
        billingProfileId: profile.id,
        planType: PROVISIONED_PLAN_TYPE,
        documentsGranted,
        creditsAvailable: await this.countAvailableCredits(manager, profile.id),
        apiKeyId: issued.id,
        apiKeyPrefix: issued.prefix,
        apiKey: issued.key,
        replayed: false,
      },
    };
  }

  /**
   * Busca el aprovisionamiento que ya confirmó esta clave y arma su respuesta, sin la llave.
   *
   * @param manager - Transacción en curso (con la clave bloqueada).
   * @param idempotencyKey - Clave de la petición.
   * @param requestHash - Huella del body de la petición.
   * @returns La respuesta de la repetición, o `null` si la clave no se ha usado.
   *
   * @throws {ProvisioningIdempotencyKeyMismatchException} (409) Si la clave se usó con otros datos.
   *
   * @example
   * ```ts
   * const replay = await this.findReplay(manager, 'prov-acme-001', hash);
   * ```
   */
  private async findReplay(
    manager: EntityManager,
    idempotencyKey: string,
    requestHash: string,
  ): Promise<ProvisionedEnterpriseAccountData | null> {
    const previous = await manager
      .getRepository(PlatformProvisioningRequestEntity)
      .findOne({ where: { idempotencyKey } });
    if (!previous) {
      return null;
    }
    if (previous.requestHash !== requestHash) {
      throw new ProvisioningIdempotencyKeyMismatchException();
    }

    const [owner, membership, profile, apiKey] = await Promise.all([
      manager.getRepository(UserEntity).findOneOrFail({
        where: { id: previous.ownerUserId },
        select: { id: true, lifecycleStatus: true },
      }),
      manager.getRepository(AccountEntity).findOneOrFail({
        where: { id: previous.organizationAccountId },
        relations: { role: true },
      }),
      manager.getRepository(BillingProfileEntity).findOneOrFail({
        where: { id: previous.billingProfileId },
      }),
      manager.getRepository(ApiKeyEntity).findOneOrFail({
        where: { id: previous.apiKeyId },
        select: { id: true, keyPrefix: true },
      }),
    ]);

    return {
      organizationId: previous.organizationId,
      organizationAccountId: previous.organizationAccountId,
      ownerUserId: previous.ownerUserId,
      ownerAccountId: previous.ownerAccountId,
      ownerLifecycleStatus: owner.lifecycleStatus,
      ownerRole: membership.role?.name ?? SYSTEM_ROLE_NAME_ENUM.OWNER,
      billingProfileId: previous.billingProfileId,
      planType: profile.currentPlanType ?? PROVISIONED_PLAN_TYPE,
      documentsGranted: previous.documentsGranted,
      creditsAvailable: await this.countAvailableCredits(manager, profile.id),
      apiKeyId: apiKey.id,
      apiKeyPrefix: apiKey.keyPrefix,
      apiKey: null,
      replayed: true,
    };
  }

  /**
   * Saldo utilizable del perfil: lo que queda en lotes que no han caducado, con la misma regla que
   * `ConsumeDocumentCreditUseCase`.
   *
   * @param manager - Transacción en curso.
   * @param billingProfileId - Perfil a consultar.
   * @returns Créditos disponibles.
   *
   * @example
   * ```ts
   * await this.countAvailableCredits(manager, 'bp-1'); // 1600
   * ```
   */
  private async countAvailableCredits(
    manager: EntityManager,
    billingProfileId: string,
  ): Promise<number> {
    const row = await manager
      .createQueryBuilder(CreditLotEntity, 'lot')
      .select('COALESCE(SUM(lot.remaining), 0)', 'available')
      .where('lot.billing_profile_id = :billingProfileId', {
        billingProfileId,
      })
      .andWhere('lot.remaining > 0')
      .andWhere('(lot.expires_at IS NULL OR lot.expires_at > now())')
      .getRawOne<{ available: string | number }>();

    return Number(row?.available ?? 0);
  }

  /**
   * Suma al catálogo de Redis del propietario las cuentas nuevas: la membresía en la organización y,
   * si el usuario se creó ahora, su cuenta personal. Best-effort (`appendAccountToCatalog` no lanza).
   *
   * @param created - Lo creado en la transacción.
   * @returns Nada.
   *
   * @example
   * ```ts
   * await this.publishToCatalog(created);
   * ```
   */
  private async publishToCatalog(created: CreatedProvisioning): Promise<void> {
    const userId = created.owner.user.id;
    if (created.owner.created) {
      await this.accountService.appendAccountToCatalog(
        userId,
        created.owner.personalAccount,
      );
    }
    await this.accountService.appendAccountToCatalog(
      userId,
      created.membership,
    );
  }
}

/**
 * Huella del aprovisionamiento pedido: SHA-256 de los datos normalizados (con el valor por omisión
 * de `documentsGranted` ya aplicado y las fechas en ISO), independiente del orden de las claves del
 * JSON. Un reintento legítimo produce la misma huella.
 *
 * @param dto - Body ya validado y transformado.
 * @returns La huella en hexadecimal (64 caracteres).
 *
 * @example
 * ```ts
 * buildProvisioningRequestHash(dto); // 'c0ffee…'
 * ```
 */
export function buildProvisioningRequestHash(
  dto: ProvisionProvisionalEnterpriseAccountDto,
): string {
  const normalized = [
    dto.organization.name,
    dto.organization.organizationName,
    dto.organization.taxId ?? null,
    dto.organization.domainAllowed ?? null,
    dto.owner.firstName,
    dto.owner.lastName,
    dto.owner.email,
    dto.billing.documentsGranted ?? DEFAULT_PROVISIONED_DOCUMENTS_GRANTED,
    dto.billing.periodStart.toISOString(),
    dto.billing.periodEnd.toISOString(),
    dto.billing.externalReference,
    dto.apiKeyName,
  ];

  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

/**
 * Reconoce un choque contra un índice único: otra transacción creó lo mismo (el usuario del
 * correo, sobre todo) entre la lectura y la escritura.
 *
 * @param error - Lo que lanzó la transacción.
 * @returns `true` si es SQLSTATE `23505`.
 *
 * @example
 * ```ts
 * if (isUniqueViolation(error)) throw new ConcurrentProvisioningException();
 * ```
 */
function isUniqueViolation(error: unknown): boolean {
  return (
    (error as { driverError?: { code?: string } })?.driverError?.code ===
    '23505'
  );
}
