import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { createHash } from 'crypto';
import { DataSource, EntityManager } from 'typeorm';

import { OrganizationEntity } from 'src/account/entities/organization.entity';
import { countAvailableCredits } from 'src/billing/credits/count-available-credits.util';
import { CreditLotEntity } from 'src/billing/credits/credit-lot.entity';
import { recordLotIssued } from 'src/billing/credits/credit-ledger.util';
import { CREDIT_LEDGER_MOVEMENT_TYPE_ENUM } from 'src/billing/enums/credit-ledger-movement-type.enum';
import { CREDIT_TYPE_ENUM } from 'src/billing/enums/credit-type.enum';
import { ADD_ON_LOT_PRIORITY } from 'src/billing/credits/register-document-credit-purchase.use-case';
import { BILLING_PROFILE_SOURCE_ENUM } from 'src/billing/enums/billing-profile-source.enum';
import { BILLING_PROFILE_STATUS_ENUM } from 'src/billing/enums/billing-profile-status.enum';
import { CREDIT_LOT_ORIGIN_ENUM } from 'src/billing/enums/credit-lot-origin.enum';
import { BillingProfileEntity } from 'src/billing/profiles/billing-profile.entity';
import { BaseResponse } from 'src/interfaces/api-response.dto';

import { PROVISIONED_PLAN_TYPE } from '../constants/provisioning-billing.constants';
import { GrantOrganizationCreditsDto } from '../dto/grant-organization-credits.dto';
import { PlatformCreditGrantEntity } from '../entities/platform-credit-grant.entity';
import {
  CreditGrantExternalReferenceAlreadyUsedException,
  CreditGrantIdempotencyKeyMismatchException,
  CreditGrantOrganizationInactiveException,
  CreditGrantOrganizationNotFoundException,
  CreditGrantProfileNotEligibleException,
} from '../exceptions/platform.exceptions';
import { OrganizationCreditGrantData } from '../interfaces/grant-organization-credits-response';

/**
 * Espacio del bloqueo asesor (`pg_advisory_xact_lock(namespace, hashtext(clave))`) que serializa
 * las recargas con el mismo `Idempotency-Key`. Es el número de la migración que creó la tabla.
 */
export const CREDIT_GRANT_ADVISORY_LOCK_NAMESPACE = 1784300092;

/** Índice único que rechaza un folio repetido; ver `isExternalReferenceViolation`. */
const EXTERNAL_REFERENCE_CONSTRAINT =
  'UQ_platform_credit_grants_external_reference';

/** Explica una repetición: no se acreditó nada y el saldo es el de ahora. */
export const CREDIT_GRANT_REPLAYED_MESSAGE =
  'Esta recarga ya se había completado con el mismo Idempotency-Key. No se acreditó nada de nuevo.';

/**
 * Explica el resultado de una recarga nueva.
 *
 * @param documentsGranted - Créditos acreditados.
 * @returns El mensaje de la respuesta.
 *
 * @example
 * ```ts
 * creditGrantMessage(500); // 'Se acreditaron 500 crédito(s) a la organización.'
 * ```
 */
export function creditGrantMessage(documentsGranted: number): string {
  return `Se acreditaron ${documentsGranted} crédito(s) a la organización.`;
}

/** Lo que llega del controller, ya autenticado y validado. */
export interface GrantOrganizationCreditsCommand {
  organizationId: string;
  dto: GrantOrganizationCreditsDto;
  /** Header `Idempotency-Key`, ya validado. */
  idempotencyKey: string;
}

/**
 * `POST /api/v1/platform/organizations/:organizationId/credits`: acredita créditos adicionales a una
 * organización Enterprise con facturación manual, sin pasar por Stripe.
 *
 * **Sólo agrega.** Crea un `credit_lot` `ADD_ON` y su constancia en `platform_credit_grants`. No toca
 * los lotes existentes ni el plan, el periodo o el estado del perfil. El lote no caduca ni pertenece
 * a un periodo, igual que una compra suelta: el saldo es la suma de los lotes y la renovación del
 * periodo sólo reetiqueta los de origen `CURRENT_PERIOD`.
 *
 * **Todo en una transacción.** El lote y su constancia quedan o no quedan juntos.
 *
 * **Idempotente por `Idempotency-Key`.** Las peticiones con la misma clave se serializan con un
 * bloqueo asesor; la que llega después de una confirmada encuentra su fila y responde con lo ya
 * acreditado (`replayed: true`) y el saldo actual. Esa búsqueda va antes de validar la organización:
 * un reintento de una recarga ya hecha responde igual aunque la organización haya cambiado después.
 * La misma clave con otros datos, incluida otra organización, es 409.
 */
@Injectable()
export class GrantOrganizationCreditsUseCase {
  private readonly logger = new Logger(GrantOrganizationCreditsUseCase.name);

  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  /**
   * Acredita la recarga, o responde con la que ya confirmó esa misma clave.
   *
   * @param command - Organización, body validado e `Idempotency-Key`.
   * @returns La recarga, el saldo actualizado y si fue una repetición.
   *
   * @throws {CreditGrantIdempotencyKeyMismatchException} (409) Si la clave ya se usó con otros datos.
   * @throws {CreditGrantExternalReferenceAlreadyUsedException} (409) Si el folio ya está registrado
   *   en otra recarga.
   * @throws {CreditGrantOrganizationNotFoundException} (404) Si la organización no existe.
   * @throws {CreditGrantOrganizationInactiveException} (422) Si la organización está desactivada.
   * @throws {CreditGrantProfileNotEligibleException} (422) Si su perfil no es Enterprise manual activo.
   *
   * @example
   * ```ts
   * const { data } = await grantCredits.execute({
   *   organizationId: 'org-1',
   *   dto: { documentsGranted: 500, externalReference: 'RECARGA-ACME-2026-001' },
   *   idempotencyKey: 'recarga-acme-001',
   * });
   * data.creditsAvailable; // 500
   * ```
   */
  async execute(
    command: GrantOrganizationCreditsCommand,
  ): Promise<BaseResponse<OrganizationCreditGrantData>> {
    const { organizationId, dto, idempotencyKey } = command;
    const requestHash = buildCreditGrantRequestHash(organizationId, dto);

    let data: OrganizationCreditGrantData;
    try {
      data = await this.dataSource.transaction(async (manager) => {
        await manager.query(
          'SELECT pg_advisory_xact_lock($1::int, hashtext($2))',
          [CREDIT_GRANT_ADVISORY_LOCK_NAMESPACE, idempotencyKey],
        );

        return (
          (await this.findReplay(manager, idempotencyKey, requestHash)) ??
          (await this.grantWithin(manager, { ...command, requestHash }))
        );
      });
    } catch (error) {
      // Lo decide el índice y no una lectura previa: dos claves distintas pueden traer el mismo folio
      // a la vez, y al fallar la inserción la transacción se lleva también el lote.
      if (isExternalReferenceViolation(error)) {
        throw new CreditGrantExternalReferenceAlreadyUsedException();
      }
      throw error;
    }

    if (data.replayed) {
      return {
        success: true,
        message: CREDIT_GRANT_REPLAYED_MESSAGE,
        data,
      };
    }

    this.logger.log(
      `Recarga ${data.grantId}: ${data.documentsGranted} crédito(s) para la organización ` +
        `${data.organizationId} en el lote ${data.creditLotId}.`,
    );

    return {
      success: true,
      message: creditGrantMessage(data.documentsGranted),
      data,
    };
  }

  /**
   * Valida la organización y su perfil, y escribe el lote y la constancia.
   *
   * El perfil se bloquea con `FOR NO KEY UPDATE` para que dos recargas de la misma organización
   * devuelvan cada una un saldo que incluya a la anterior. Ese modo no estorba al consumo de
   * créditos, cuya referencia al perfil sólo toma `FOR KEY SHARE`.
   *
   * @param manager - Transacción en curso, con la clave bloqueada.
   * @param params - Organización, body, clave y huella de la petición.
   * @returns La recarga creada con el saldo que resulta de ella.
   *
   * @throws {CreditGrantOrganizationNotFoundException} (404) Si la organización no existe.
   * @throws {CreditGrantOrganizationInactiveException} (422) Si la organización está desactivada.
   * @throws {CreditGrantProfileNotEligibleException} (422) Si su perfil no es Enterprise manual activo.
   *
   * @example
   * ```ts
   * const data = await this.grantWithin(manager, { ...command, requestHash });
   * ```
   */
  private async grantWithin(
    manager: EntityManager,
    params: GrantOrganizationCreditsCommand & { requestHash: string },
  ): Promise<OrganizationCreditGrantData> {
    const { organizationId, dto } = params;

    const organization = await manager
      .getRepository(OrganizationEntity)
      .findOne({
        where: { id: organizationId },
        select: { id: true, isActive: true },
      });
    if (!organization) {
      throw new CreditGrantOrganizationNotFoundException();
    }
    if (!organization.isActive) {
      throw new CreditGrantOrganizationInactiveException();
    }

    const profile = await manager.getRepository(BillingProfileEntity).findOne({
      where: { organizationId },
      lock: { mode: 'for_no_key_update' },
    });
    if (!profile || !isEnterpriseManualProfile(profile)) {
      throw new CreditGrantProfileNotEligibleException();
    }

    const lots = manager.getRepository(CreditLotEntity);
    const lot = await lots.save(
      lots.create({
        billingProfileId: profile.id,
        origin: CREDIT_LOT_ORIGIN_ENUM.ADD_ON,
        creditType: CREDIT_TYPE_ENUM.DOCUMENT_SIGNATURE,
        issued: dto.documentsGranted,
        remaining: dto.documentsGranted,
        reserved: 0,
        priority: ADD_ON_LOT_PRIORITY,
        stripeInvoiceId: null,
        stripePaymentIntentId: null,
        stripeSubscriptionId: null,
        periodStart: null,
        periodEnd: null,
        expiresAt: null,
      }),
    );

    // La recarga se cobra por fuera de la plataforma: en el ledger es una concesión.
    await recordLotIssued(
      manager,
      lot,
      CREDIT_LEDGER_MOVEMENT_TYPE_ENUM.GRANT,
      {
        externalReference: dto.externalReference,
        idempotencyKey: params.idempotencyKey,
      },
    );

    const grants = manager.getRepository(PlatformCreditGrantEntity);
    const grant = await grants.save(
      grants.create({
        organizationId,
        billingProfileId: profile.id,
        creditLotId: lot.id,
        documentsGranted: dto.documentsGranted,
        externalReference: dto.externalReference,
        idempotencyKey: params.idempotencyKey,
        requestHash: params.requestHash,
        notes: dto.notes || null,
      }),
    );

    return toGrantData(
      grant,
      await countAvailableCredits(manager, profile.id),
      false,
    );
  }

  /**
   * Busca la recarga que ya confirmó esta clave y arma su respuesta con el saldo actual.
   *
   * @param manager - Transacción en curso, con la clave bloqueada.
   * @param idempotencyKey - Clave de la petición.
   * @param requestHash - Huella de la petición.
   * @returns La respuesta de la repetición, o `null` si la clave no se ha usado.
   *
   * @throws {CreditGrantIdempotencyKeyMismatchException} (409) Si la clave se usó con otros datos.
   *
   * @example
   * ```ts
   * const replay = await this.findReplay(manager, 'recarga-acme-001', hash);
   * ```
   */
  private async findReplay(
    manager: EntityManager,
    idempotencyKey: string,
    requestHash: string,
  ): Promise<OrganizationCreditGrantData | null> {
    const previous = await manager
      .getRepository(PlatformCreditGrantEntity)
      .findOne({ where: { idempotencyKey } });
    if (!previous) {
      return null;
    }
    if (previous.requestHash !== requestHash) {
      throw new CreditGrantIdempotencyKeyMismatchException();
    }

    return toGrantData(
      previous,
      await countAvailableCredits(manager, previous.billingProfileId),
      true,
    );
  }
}

/**
 * Huella de la recarga pedida: SHA-256 de los datos normalizados, independiente del orden de las
 * claves del JSON. Un reintento legítimo produce la misma huella.
 *
 * @param organizationId - Organización de la ruta.
 * @param dto - Body ya validado y transformado.
 * @returns La huella en hexadecimal (64 caracteres).
 *
 * @example
 * ```ts
 * buildCreditGrantRequestHash('org-1', dto); // 'c0ffee…'
 * ```
 */
export function buildCreditGrantRequestHash(
  organizationId: string,
  dto: GrantOrganizationCreditsDto,
): string {
  const normalized = [
    organizationId,
    dto.documentsGranted,
    dto.externalReference,
    dto.notes || null,
  ];

  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

/**
 * Decide si a un perfil le corresponde una recarga interna: plan `enterprise`, facturado a mano y
 * vigente. Un perfil de Stripe compra sus documentos por Stripe.
 *
 * @param profile - Perfil de la organización.
 * @returns `true` si admite la recarga.
 *
 * @example
 * ```ts
 * isEnterpriseManualProfile(profile); // true
 * ```
 */
function isEnterpriseManualProfile(profile: BillingProfileEntity): boolean {
  return (
    profile.currentPlanType === PROVISIONED_PLAN_TYPE &&
    profile.billingSource === BILLING_PROFILE_SOURCE_ENUM.MANUAL &&
    profile.status === BILLING_PROFILE_STATUS_ENUM.ACTIVE
  );
}

/**
 * Arma la respuesta a partir de la constancia de la recarga.
 *
 * @param grant - Fila de `platform_credit_grants`.
 * @param creditsAvailable - Saldo actual del perfil.
 * @param replayed - Si la respuesta repite una recarga ya confirmada.
 * @returns Los datos de la respuesta.
 *
 * @example
 * ```ts
 * toGrantData(grant, 500, false).creditLotId; // 'lot-1'
 * ```
 */
function toGrantData(
  grant: PlatformCreditGrantEntity,
  creditsAvailable: number,
  replayed: boolean,
): OrganizationCreditGrantData {
  return {
    grantId: grant.id,
    organizationId: grant.organizationId,
    billingProfileId: grant.billingProfileId,
    creditLotId: grant.creditLotId,
    documentsGranted: grant.documentsGranted,
    creditsAvailable,
    externalReference: grant.externalReference,
    replayed,
  };
}

/**
 * Reconoce el choque contra el índice único del folio.
 *
 * @param error - Lo que lanzó la transacción.
 * @returns `true` si es SQLSTATE `23505` sobre `UQ_platform_credit_grants_external_reference`.
 *
 * @example
 * ```ts
 * if (isExternalReferenceViolation(error)) throw new CreditGrantExternalReferenceAlreadyUsedException();
 * ```
 */
function isExternalReferenceViolation(error: unknown): boolean {
  const driverError = (
    error as { driverError?: { code?: string; constraint?: string } }
  )?.driverError;

  return (
    driverError?.code === '23505' &&
    driverError.constraint === EXTERNAL_REFERENCE_CONSTRAINT
  );
}
