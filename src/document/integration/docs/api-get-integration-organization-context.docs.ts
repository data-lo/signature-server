import { applyDecorators } from '@nestjs/common';
import { ApiOperation, ApiResponse } from '@nestjs/swagger';

import { IntegrationOrganizationContextResponse } from '../interfaces/integration-organization-context-response';
import { ApiIntegrationCommonResponses } from './api-integration-documents-common.docs';

/** Ejemplo de la respuesta exitosa. */
const ORGANIZATION_CONTEXT_EXAMPLE = {
  success: true,
  message: 'Contexto de la organización obtenido correctamente',
  data: {
    organization: {
      id: '1f2e3d4c-5b6a-4978-8a9b-0c1d2e3f4a5b',
      name: 'Empresa Ejemplo S.A. de C.V.',
      status: 'active',
    },
    signatureQuota: {
      planLimit: 1000,
      documentsSigned: 725,
      documentsRemaining: 275,
      periodStart: '2026-11-01',
      periodEnd: '2026-11-30',
    },
    billing: {
      plan: 'Business',
      status: 'active',
      billingCycle: 'monthly',
      nextBillingDate: '2026-12-01',
      paymentStatus: 'paid',
    },
  },
};

/**
 * `GET /api/v1/integration/organization/context`.
 *
 * @returns Los decoradores de Swagger del endpoint.
 *
 * @example
 * ```ts
 * @ApiGetIntegrationOrganizationContext()
 * ```
 */
export function ApiGetIntegrationOrganizationContext() {
  return applyDecorators(
    ApiOperation({
      summary: 'Consultar la organización y su saldo',
      description: [
        'Devuelve tu organización, cuántos documentos puedes crear todavía (`signatureQuota.documentsRemaining`) y un resumen de su plan. Consúltalo antes de crear documentos en lote para no recibir `402`.',
        'No recibe parámetros: la organización es la de la API key. No incluye datos de pago.',
        '**Permiso:** `DOCUMENT.READ` con alcance `ORGANIZATION`. Una llave con alcance `OWN` recibe `403 API_KEY_PERMISSION_DENIED`.',
      ].join('\n\n'),
    }),
    ApiIntegrationCommonResponses(),
    ApiResponse({
      status: 200,
      description:
        'Organización, saldo y plan. Si la organización no tiene plan, los contadores valen `0` y los datos del plan, `null`.',
      type: IntegrationOrganizationContextResponse,
      example: ORGANIZATION_CONTEXT_EXAMPLE,
    }),
  );
}
