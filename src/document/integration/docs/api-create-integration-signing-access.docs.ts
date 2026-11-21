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
      summary: 'Generar un enlace de firma para tu portal',
      description: [
        'Devuelve una URL de un solo uso para que el firmante con ese `email` firme desde tu portal. Redirige al firmante a esa URL en cuanto la recibas: vence en 5 minutos.',
        'Al abrirla, Firmalo envía un código al correo del firmante y no muestra el documento hasta que lo valida.',
        'Puedes pedir hasta diez enlaces cada 10 minutos por firmante.',
        '**Permiso:** `DOCUMENT.CREATE` con alcance `ORGANIZATION`.',
      ].join('\n\n'),
    }),
    ApiParam({
      name: 'documentId',
      format: 'uuid',
      description: 'El `id` que devolvió `POST /api/v1/integration/documents`.',
      example: '2be3b9d7-4c5d-4e6f-8a9b-0c1d2e3f4a5b',
    }),
    ApiIntegrationCommonResponses(),
    ApiResponse({
      status: 200,
      description: 'Enlace generado, con su vencimiento.',
      type: IntegrationSigningAccessResponse,
      example: {
        success: true,
        message: 'Acceso temporal de firma generado',
        data: {
          url: 'https://app.firmalo.com/sign/launch/EjemploDeTokenNoReal',
          expiresAt: '2026-10-26T12:05:00.000Z',
        },
      },
    }),
    ApiResponse({
      status: 404,
      description:
        '`INTEGRATION_SIGNER_NOT_FOUND`: el documento no es de tu organización o no tiene un firmante con ese correo.',
      type: IntegrationErrorResponseDto,
      examples: { signerNotFound: SIGNER_NOT_FOUND_EXAMPLE },
    }),
    ApiResponse({
      status: 409,
      description:
        '`WAITING_FOR_PREVIOUS_SIGNER`: el documento es secuencial y falta la firma de un firmante anterior; pide el enlace cuando sea su turno. `INTEGRATION_INVITATION_NOT_RESENDABLE`: el firmante ya firmó o rechazó, el documento ya no espera firmas, o el firmante firma desde su cuenta de Firmalo. `INTEGRATION_AMBIGUOUS_SIGNER`: más de un firmante tiene ese correo.',
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
      description: '`INVALID_REQUEST`: falta `email` o no es un correo válido.',
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
        '`TOO_MANY_REQUESTS`: ya pediste diez enlaces para ese firmante en los últimos 10 minutos. Espera antes de pedir otro.',
      type: IntegrationErrorResponseDto,
      examples: { tooManyRequests: TOO_MANY_REQUESTS_EXAMPLE },
    }),
  );
}
