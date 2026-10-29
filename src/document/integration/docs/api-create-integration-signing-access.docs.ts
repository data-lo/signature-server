import { applyDecorators } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse } from '@nestjs/swagger';

import {
  IntegrationErrorResponseDto,
  IntegrationSigningAccessResponse,
} from '../interfaces/integration-document-response';
import { ApiIntegrationCommonResponses } from './api-integration-documents-common.docs';
import {
  INVALID_REQUEST_EXAMPLE,
  integrationErrorExample,
  TOO_MANY_REQUESTS_EXAMPLE,
} from './api-integration-examples.docs';

/** 404 de un firmante que no está en un documento de la organización. */
export const SIGNER_NOT_FOUND_EXAMPLE = integrationErrorExample(
  'Firmante no encontrado',
  'INTEGRATION_SIGNER_NOT_FOUND',
  'No existe ese firmante en un documento de la organización',
);

/** 409 de un firmante que ya no espera firma. */
export const NOT_RESENDABLE_EXAMPLE = integrationErrorExample(
  'El firmante ya no espera firma',
  'INTEGRATION_INVITATION_NOT_RESENDABLE',
  'El documento ya no espera la firma de este firmante',
);

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
        'Requiere `DOCUMENT.CREATE`. Llamar desde el backend del tercero, nunca desde el navegador. Devuelve una URL `/sign/launch/:token` de un solo uso que vence en 5 minutos. El correo sólo localiza al firmante: al abrir la URL, la plataforma le envía un código a ese correo y no muestra el documento ni permite firmar sin validarlo. Diez accesos cada 10 minutos por firmante.',
    }),
    ApiParam({
      name: 'documentId',
      format: 'uuid',
      example: '2be3b9d7-4c5d-4e6f-8a9b-0c1d2e3f4a5b',
    }),
    ApiIntegrationCommonResponses('DOCUMENT.CREATE'),
    ApiResponse({
      status: 200,
      description: 'Acceso temporal emitido',
      type: IntegrationSigningAccessResponse,
    }),
    ApiResponse({
      status: 404,
      description:
        '`INTEGRATION_SIGNER_NOT_FOUND`: el documento no es de la organización o ningún firmante tiene ese correo',
      type: IntegrationErrorResponseDto,
      examples: { signerNotFound: SIGNER_NOT_FOUND_EXAMPLE },
    }),
    ApiResponse({
      status: 409,
      description:
        '`WAITING_FOR_PREVIOUS_SIGNER` (no es su turno), `INTEGRATION_AMBIGUOUS_SIGNER` (más de un firmante con ese correo) o `INTEGRATION_INVITATION_NOT_RESENDABLE` (ya no espera esa firma o firma desde su cuenta)',
      type: IntegrationErrorResponseDto,
      examples: {
        notInTurn: integrationErrorExample(
          'No es su turno',
          'WAITING_FOR_PREVIOUS_SIGNER',
          'Todavía no es el turno de este firmante: falta la firma de un firmante anterior',
        ),
        ambiguous: integrationErrorExample(
          'Correo de más de un firmante',
          'INTEGRATION_AMBIGUOUS_SIGNER',
          'El correo corresponde a más de un firmante del documento',
        ),
        notResendable: NOT_RESENDABLE_EXAMPLE,
      },
    }),
    ApiResponse({
      status: 422,
      description: '`INVALID_REQUEST`: `email` no es un correo válido.',
      type: IntegrationErrorResponseDto,
      examples: {
        invalidRequest: integrationErrorExample(
          INVALID_REQUEST_EXAMPLE.summary,
          'INVALID_REQUEST',
          'La petición tiene campos inválidos.',
          { errors: ['email debe ser un correo válido'] },
        ),
      },
    }),
    ApiResponse({
      status: 429,
      description:
        '`TOO_MANY_REQUESTS`: se superaron los diez accesos en 10 minutos para ese firmante.',
      type: IntegrationErrorResponseDto,
      examples: { tooManyRequests: TOO_MANY_REQUESTS_EXAMPLE },
    }),
  );
}
