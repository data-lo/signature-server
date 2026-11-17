import { ApiProperty } from '@nestjs/swagger';

import { BILLING_PROFILE_STATUS_ENUM } from 'src/billing/enums/billing-profile-status.enum';
import { BaseResponse } from 'src/interfaces/api-response.dto';

/** Ciclo de cobro, deducido de la duración del periodo vigente. */
export enum INTEGRATION_BILLING_CYCLE_ENUM {
  MONTHLY = 'monthly',
  YEARLY = 'yearly',
  CUSTOM = 'custom',
}

/** Estado de pago del periodo vigente. */
export enum INTEGRATION_PAYMENT_STATUS_ENUM {
  PAID = 'paid',
  PAST_DUE = 'past_due',
  PENDING = 'pending',
  NOT_APPLICABLE = 'not_applicable',
}

/** La organización de la API key. */
export class IntegrationOrganizationData {
  @ApiProperty({
    format: 'uuid',
    example: '1f2e3d4c-5b6a-4978-8a9b-0c1d2e3f4a5b',
  })
  id: string;

  @ApiProperty({
    example: 'Empresa Ejemplo S.A. de C.V.',
    description: 'Razón social',
  })
  name: string;

  @ApiProperty({
    enum: ['active'],
    example: 'active',
    description:
      'Siempre `active`: una llave de una organización desactivada responde `403 API_KEY_ORGANIZATION_INACTIVE`',
  })
  status: 'active';
}

/** Saldo de documentos de la organización. */
export class IntegrationSignatureQuotaData {
  @ApiProperty({
    example: 1000,
    description: 'Documentos que incluye el periodo vigente del plan',
  })
  planLimit: number;

  @ApiProperty({
    example: 725,
    description:
      'Documentos que terminaron de firmarse durante el periodo vigente; `0` si no hay periodo vigente',
  })
  documentsSigned: number;

  @ApiProperty({
    example: 275,
    description:
      'Documentos que todavía se pueden crear para firma: suma los créditos vigentes del plan, los arrastrados y los comprados aparte, así que puede superar a `planLimit`. Un crédito se consume al crear el documento, no al firmarlo, por lo que no equivale a `planLimit - documentsSigned`. `0` si se agotó.',
  })
  documentsRemaining: number;

  @ApiProperty({
    type: String,
    format: 'date',
    nullable: true,
    example: '2026-11-01',
    description: 'Primer día del periodo vigente (UTC)',
  })
  periodStart: string | null;

  @ApiProperty({
    type: String,
    format: 'date',
    nullable: true,
    example: '2026-11-30',
    description: 'Último día cubierto por el periodo vigente (UTC)',
  })
  periodEnd: string | null;
}

/** Resumen de facturación. Nunca lleva datos de tarjeta, tokens, facturas ni datos bancarios. */
export class IntegrationBillingSummaryData {
  @ApiProperty({
    type: String,
    nullable: true,
    example: 'Business',
    description: 'Nombre del plan; `null` si la organización no tiene plan',
  })
  plan: string | null;

  @ApiProperty({
    enum: Object.values(BILLING_PROFILE_STATUS_ENUM).map((status) =>
      status.toLowerCase(),
    ),
    nullable: true,
    example: 'active',
    description: '`null` si la organización nunca pasó por facturación',
  })
  status: string | null;

  @ApiProperty({
    enum: INTEGRATION_BILLING_CYCLE_ENUM,
    nullable: true,
    example: INTEGRATION_BILLING_CYCLE_ENUM.MONTHLY,
    description:
      'Según la duración del periodo vigente; `custom` si no es mensual ni anual, y `null` sin periodo',
  })
  billingCycle: INTEGRATION_BILLING_CYCLE_ENUM | null;

  @ApiProperty({
    type: String,
    format: 'date',
    nullable: true,
    example: '2026-12-01',
    description:
      'Fecha de renovación (UTC); `null` si no habrá otro cobro: sin plan de pago o con la baja programada',
  })
  nextBillingDate: string | null;

  @ApiProperty({
    enum: INTEGRATION_PAYMENT_STATUS_ENUM,
    example: INTEGRATION_PAYMENT_STATUS_ENUM.PAID,
    description:
      '`paid` (al corriente), `past_due` (cobro fallido), `pending` (contratación sin confirmar) o `not_applicable` (sin plan de pago)',
  })
  paymentStatus: INTEGRATION_PAYMENT_STATUS_ENUM;
}

/** Contexto de la organización resuelta desde la API key. */
export class IntegrationOrganizationContextData {
  @ApiProperty({ type: IntegrationOrganizationData })
  organization: IntegrationOrganizationData;

  @ApiProperty({ type: IntegrationSignatureQuotaData })
  signatureQuota: IntegrationSignatureQuotaData;

  @ApiProperty({ type: IntegrationBillingSummaryData })
  billing: IntegrationBillingSummaryData;
}

export class IntegrationOrganizationContextResponse extends BaseResponse<IntegrationOrganizationContextData> {
  @ApiProperty({
    example: 'Contexto de la organización obtenido correctamente',
  })
  message: string;

  @ApiProperty({ type: IntegrationOrganizationContextData })
  data: IntegrationOrganizationContextData;
}
