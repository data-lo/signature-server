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
      summary: 'Consultar la organización, su saldo de documentos y su plan',
      description:
        'La organización se resuelve exclusivamente desde la API key: no se envía ningún identificador. Requiere `DOCUMENT.READ` con alcance `ORGANIZATION`. Nunca incluye datos de tarjeta, tokens de pago, facturas ni datos bancarios.',
    }),
    ApiIntegrationCommonResponses(),
    ApiResponse({
      status: 200,
      description:
        'Contexto de la organización. Sin plan ni facturación, los contadores van en `0` y los datos del plan en `null`.',
      type: IntegrationOrganizationContextResponse,
      example: ORGANIZATION_CONTEXT_EXAMPLE,
    }),
  );
}
