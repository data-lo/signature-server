import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { And, LessThan, MoreThan, MoreThanOrEqual, Repository } from 'typeorm';

import { OrganizationEntity } from 'src/account/entities/organization.entity';
import { ApiKeyOrganizationInactiveException } from 'src/api-key/exceptions/api-key.exceptions';
import { IntegrationApiClient } from 'src/api-key/interfaces/integration-api-client.interface';
import { countAvailableCredits } from 'src/billing/credits/count-available-credits.util';
import { CreditLotEntity } from 'src/billing/credits/credit-lot.entity';
import { BILLING_PROFILE_STATUS_ENUM } from 'src/billing/enums/billing-profile-status.enum';
import { CREDIT_LOT_ORIGIN_ENUM } from 'src/billing/enums/credit-lot-origin.enum';
import { BillingProfileEntity } from 'src/billing/profiles/billing-profile.entity';
import { BaseResponse } from 'src/interfaces/api-response.dto';

import { DocumentEntity } from '../../entities/document.entity';
import { DOCUMENT_STATUS_ENUM } from '../../enum/document-status.enum';
import {
  INTEGRATION_BILLING_CYCLE_ENUM,
  INTEGRATION_PAYMENT_STATUS_ENUM,
  IntegrationBillingSummaryData,
  IntegrationOrganizationContextData,
  IntegrationSignatureQuotaData,
} from '../interfaces/integration-organization-context-response';

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Fecha UTC, sin hora, de un instante.
 *
 * @param date - Instante a formatear.
 * @returns La fecha como `AAAA-MM-DD`.
 *
 * @example
 * ```ts
 * toDateOnly(new Date('2026-11-30T23:00:00.000Z')); // '2026-11-30'
 * ```
 */
function toDateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Último día que cubre un periodo. `current_period_end` es el instante en que termina, normalmente
 * la medianoche del día siguiente, así que se resta un milisegundo para no anunciar un día de más.
 *
 * @param periodEnd - Instante en que termina el periodo.
 * @returns El último día cubierto, como `AAAA-MM-DD`.
 *
 * @example
 * ```ts
 * toLastCoveredDay(new Date('2026-12-01T00:00:00.000Z')); // '2026-11-30'
 * ```
 */
function toLastCoveredDay(periodEnd: Date): string {
  return toDateOnly(new Date(periodEnd.getTime() - 1));
}

/**
 * Ciclo de cobro según la duración del periodo. El perfil no lo guarda, y deducirlo del periodo
 * sirve igual para Stripe y para la facturación manual.
 *
 * @param periodStart - Inicio del periodo, si lo hay.
 * @param periodEnd - Fin del periodo, si lo hay.
 * @returns `monthly`, `yearly`, `custom`, o `null` sin periodo.
 *
 * @example
 * ```ts
 * resolveBillingCycle(new Date('2026-11-01'), new Date('2026-12-01')); // 'monthly'
 * ```
 */
function resolveBillingCycle(
  periodStart: Date | null,
  periodEnd: Date | null,
): INTEGRATION_BILLING_CYCLE_ENUM | null {
  if (!periodStart || !periodEnd) return null;

  const days = Math.round(
    (periodEnd.getTime() - periodStart.getTime()) / MILLISECONDS_PER_DAY,
  );
  if (days >= 28 && days <= 31) return INTEGRATION_BILLING_CYCLE_ENUM.MONTHLY;
  if (days === 365 || days === 366)
    return INTEGRATION_BILLING_CYCLE_ENUM.YEARLY;
  return INTEGRATION_BILLING_CYCLE_ENUM.CUSTOM;
}

/**
 * Traduce el estado comercial del perfil a un estado de pago.
 *
 * @param status - Estado del perfil.
 * @returns El estado de pago del periodo vigente.
 *
 * @example
 * ```ts
 * resolvePaymentStatus(BILLING_PROFILE_STATUS_ENUM.PAST_DUE); // 'past_due'
 * ```
 */
function resolvePaymentStatus(
  status: BILLING_PROFILE_STATUS_ENUM,
): INTEGRATION_PAYMENT_STATUS_ENUM {
  switch (status) {
    case BILLING_PROFILE_STATUS_ENUM.ACTIVE:
      return INTEGRATION_PAYMENT_STATUS_ENUM.PAID;
    case BILLING_PROFILE_STATUS_ENUM.PAST_DUE:
      return INTEGRATION_PAYMENT_STATUS_ENUM.PAST_DUE;
    case BILLING_PROFILE_STATUS_ENUM.INCOMPLETE:
      return INTEGRATION_PAYMENT_STATUS_ENUM.PENDING;
    default:
      return INTEGRATION_PAYMENT_STATUS_ENUM.NOT_APPLICABLE;
  }
}

/**
 * Resumen de facturación de un perfil. Se arma campo por campo a propósito: el perfil también
 * guarda ids de Stripe, y nada de eso debe poder salir por esta API.
 *
 * @param profile - Perfil de la organización, con su plan cargado, o `null` si no tiene.
 * @returns El resumen público.
 *
 * @example
 * ```ts
 * toBillingSummary(null).paymentStatus; // 'not_applicable'
 * ```
 */
function toBillingSummary(
  profile: BillingProfileEntity | null,
): IntegrationBillingSummaryData {
  if (!profile) {
    return {
      plan: null,
      status: null,
      billingCycle: null,
      nextBillingDate: null,
      paymentStatus: INTEGRATION_PAYMENT_STATUS_ENUM.NOT_APPLICABLE,
    };
  }

  const renews =
    !profile.cancelAtPeriodEnd &&
    (profile.status === BILLING_PROFILE_STATUS_ENUM.ACTIVE ||
      profile.status === BILLING_PROFILE_STATUS_ENUM.PAST_DUE);

  return {
    plan: profile.currentPlan?.name ?? null,
    status: profile.status.toLowerCase(),
    billingCycle: resolveBillingCycle(
      profile.currentPeriodStart,
      profile.currentPeriodEnd,
    ),
    nextBillingDate:
      renews && profile.currentPeriodEnd
        ? toDateOnly(profile.currentPeriodEnd)
        : null,
    paymentStatus: resolvePaymentStatus(profile.status),
  };
}

/**
 * `GET /api/v1/integration/organization/context`: la organización de la API key, cuántos documentos
 * le quedan y un resumen de su facturación. La organización sale SIEMPRE de la llave.
 *
 * Sólo lee: no crea el perfil de facturación de una organización que no lo tenga.
 */
@Injectable()
export class GetIntegrationOrganizationContextUseCase {
  constructor(
    @InjectRepository(OrganizationEntity)
    private readonly organizationRepository: Repository<OrganizationEntity>,
    @InjectRepository(BillingProfileEntity)
    private readonly billingProfileRepository: Repository<BillingProfileEntity>,
    @InjectRepository(CreditLotEntity)
    private readonly creditLotRepository: Repository<CreditLotEntity>,
    @InjectRepository(DocumentEntity)
    private readonly documentRepository: Repository<DocumentEntity>,
  ) {}

  /**
   * Obtiene el contexto de la organización de la llave.
   *
   * @param apiClient - Cliente autenticado por la API key.
   * @returns La organización, su saldo de documentos y su resumen de facturación.
   *
   * @throws {ApiKeyOrganizationInactiveException} (403) Si la organización dejó de existir después
   *   de autenticar la llave.
   *
   * @example
   * ```ts
   * const { data } = await getOrganizationContext.execute(apiClient);
   * data.signatureQuota.documentsRemaining; // 275
   * ```
   */
  async execute(
    apiClient: IntegrationApiClient,
  ): Promise<BaseResponse<IntegrationOrganizationContextData>> {
    const { organizationId } = apiClient;
    const [organization, profile] = await Promise.all([
      this.organizationRepository.findOne({
        where: { id: organizationId },
        select: { id: true, name: true },
      }),
      this.billingProfileRepository.findOne({
        where: { organizationId },
        relations: { currentPlan: true },
      }),
    ]);
    if (!organization) throw new ApiKeyOrganizationInactiveException();

    return {
      success: true,
      message: 'Contexto de la organización obtenido correctamente',
      data: {
        organization: {
          id: organization.id,
          name: organization.name,
          status: 'active',
        },
        signatureQuota: await this.resolveQuota(organizationId, profile),
        billing: toBillingSummary(profile),
      },
    };
  }

  /** Saldo de la organización; todo en cero si nunca pasó por facturación. */
  private async resolveQuota(
    organizationId: string,
    profile: BillingProfileEntity | null,
  ): Promise<IntegrationSignatureQuotaData> {
    if (!profile) {
      return {
        planLimit: 0,
        documentsSigned: 0,
        documentsRemaining: 0,
        periodStart: null,
        periodEnd: null,
      };
    }

    const { currentPeriodStart: start, currentPeriodEnd: end } = profile;
    const [planLimit, documentsSigned, documentsRemaining] = await Promise.all([
      this.resolvePlanLimit(profile),
      start && end ? this.countSignedDocuments(organizationId, start, end) : 0,
      countAvailableCredits(this.creditLotRepository.manager, profile.id),
    ]);

    return {
      planLimit,
      documentsSigned,
      documentsRemaining,
      periodStart: start ? toDateOnly(start) : null,
      periodEnd: end ? toLastCoveredDay(end) : null,
    };
  }

  /**
   * Documentos que concede el periodo vigente: lo que emitió su lote, no `plans.documents_included`,
   * porque un periodo Enterprise acredita lo pactado y la fila del plan sólo guarda un valor de
   * relleno. El periodo se exige porque un lote agotado conserva `CURRENT_PERIOD` tras renovar.
   *
   * @param profile - Perfil de la organización, con su plan cargado.
   * @returns El tamaño del lote vigente; sin lote, los documentos del plan o `0`.
   *
   * @example
   * ```ts
   * await this.resolvePlanLimit(profile); // 1600
   * ```
   */
  private async resolvePlanLimit(
    profile: BillingProfileEntity,
  ): Promise<number> {
    const billingProfileId = profile.id;
    const lot = await this.creditLotRepository.findOne({
      where: [
        {
          billingProfileId,
          origin: CREDIT_LOT_ORIGIN_ENUM.CURRENT_PERIOD,
          periodEnd: MoreThan(new Date()),
        },
        { billingProfileId, origin: CREDIT_LOT_ORIGIN_ENUM.FREE_GRANT },
      ],
      order: { createdAt: 'DESC' },
      select: { id: true, issued: true },
    });

    return lot?.issued ?? profile.currentPlan?.documentsIncluded ?? 0;
  }

  /** Documentos de la organización que terminaron de firmarse dentro del periodo. */
  private countSignedDocuments(
    organizationId: string,
    periodStart: Date,
    periodEnd: Date,
  ): Promise<number> {
    return this.documentRepository.count({
      where: {
        organizationId,
        status: DOCUMENT_STATUS_ENUM.SIGNED,
        signedAt: And(MoreThanOrEqual(periodStart), LessThan(periodEnd)),
      },
    });
  }
}
