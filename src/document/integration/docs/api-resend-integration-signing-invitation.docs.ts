import { applyDecorators } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse } from '@nestjs/swagger';

import {
  IntegrationErrorResponseDto,
  IntegrationResentInvitationResponse,
} from '../interfaces/integration-document-response';
import {
  NOT_RESENDABLE_EXAMPLE,
  SIGNER_NOT_FOUND_EXAMPLE,
} from './api-create-integration-signing-access.docs';
import { ApiIntegrationCommonResponses } from './api-integration-documents-common.docs';
import {
  INVALID_REQUEST_EXAMPLE,
  integrationErrorExample,
  TOO_MANY_REQUESTS_EXAMPLE,
} from './api-integration-examples.docs';

/**
 * `POST /api/v1/integration/documents/:documentId/collaborators/resend-invitation`.
 *
 * @returns Los decoradores de Swagger del endpoint.
 *
 * @example
 * ```ts
 * @ApiResendIntegrationSigningInvitation()
 * ```
 */
export function ApiResendIntegrationSigningInvitation() {
  return applyDecorators(
    ApiOperation({
      summary: 'Reenviar la invitación de firma a un firmante',
      description:
        'Emite una invitación nueva (`/sign/:token`) y la envía al correo del firmante; la anterior deja de servir. El enlace nunca se devuelve. A lo sumo una cada 10 minutos y diez por día por firmante. El correo sólo localiza al firmante dentro del documento. Reemplaza a `POST /documents/{documentId}/collaborators/{collaboratorId}/resend-invitation`, que ahora responde `410 INTEGRATION_ENDPOINT_RETIRED`.',
    }),
    ApiParam({
      name: 'documentId',
      format: 'uuid',
      example: '2be3b9d7-4c5d-4e6f-8a9b-0c1d2e3f4a5b',
    }),
    ApiIntegrationCommonResponses(),
    ApiResponse({
      status: 200,
      description:
        'Invitación emitida. Con `emailDelivered: false` la invitación existe pero el correo no salió; se puede reintentar.',
      type: IntegrationResentInvitationResponse,
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
        '`INTEGRATION_AMBIGUOUS_SIGNER` (más de un firmante con ese correo) o `INTEGRATION_INVITATION_NOT_RESENDABLE` (el documento ya no espera esa firma, no es su turno o firma desde su cuenta)',
      type: IntegrationErrorResponseDto,
      examples: {
        ambiguous: integrationErrorExample(
          'Correo de más de un firmante',
          'INTEGRATION_AMBIGUOUS_SIGNER',
          'El correo corresponde a más de un firmante del documento',
        ),
        notResendable: NOT_RESENDABLE_EXAMPLE,
        notInTurn: integrationErrorExample(
          'No es su turno',
          'INTEGRATION_INVITATION_NOT_RESENDABLE',
          'Todavía no es el turno de este firmante',
        ),
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
        '`TOO_MANY_REQUESTS`: ya se reenvió en los últimos 10 minutos o se alcanzaron diez reenvíos en el día.',
      type: IntegrationErrorResponseDto,
      examples: { tooManyRequests: TOO_MANY_REQUESTS_EXAMPLE },
    }),
  );
}
