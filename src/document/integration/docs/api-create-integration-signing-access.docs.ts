import { applyDecorators } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse } from '@nestjs/swagger';

import { IntegrationErrorResponseDto } from '../interfaces/integration-document-response';
import { ApiIntegrationCommonResponses } from './api-integration-documents-common.docs';

/**
 * `POST /api/v1/integration/documents/:documentId/signing-access`.
 *
 * @returns Los decoradores de Swagger del endpoint.
 *
 * @example
 * ```ts
 * @ApiCreateIntegrationSigningAccess()
 * ```
 */
export function ApiCreateIntegrationSigningAccess() {
  return applyDecorators(
    ApiOperation({
      summary: 'Generar un acceso temporal de firma para un firmante',
      description:
        'Requiere `DOCUMENT.CREATE_ORGANIZATION`. Llamar desde el backend del tercero, nunca desde el navegador. Devuelve una URL `/sign/launch/:token` de un solo uso que vence en 5 minutos. El correo sólo localiza al firmante: al abrir la URL, la plataforma le envía un código a ese correo y no muestra el documento ni permite firmar sin validarlo. Diez accesos cada 10 minutos por firmante.',
    }),
    ApiParam({ name: 'documentId', format: 'uuid' }),
    ApiIntegrationCommonResponses('DOCUMENT.CREATE_ORGANIZATION'),
    ApiResponse({
      status: 200,
      description: '{ success, message, data: { url, expiresAt } }',
    }),
    ApiResponse({
      status: 404,
      description:
        '`INTEGRATION_SIGNER_NOT_FOUND`: el documento no es de la organización o ningún firmante tiene ese correo',
      type: IntegrationErrorResponseDto,
    }),
    ApiResponse({
      status: 409,
      description:
        '`WAITING_FOR_PREVIOUS_SIGNER` (no es su turno), `INTEGRATION_AMBIGUOUS_SIGNER` (más de un firmante con ese correo) o `INTEGRATION_INVITATION_NOT_RESENDABLE` (ya no espera esa firma o firma desde su cuenta)',
      type: IntegrationErrorResponseDto,
    }),
    ApiResponse({ status: 429, description: 'Demasiados accesos' }),
  );
}
