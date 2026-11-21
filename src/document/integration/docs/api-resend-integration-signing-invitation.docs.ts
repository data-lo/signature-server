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
      summary: 'Reenviar la invitación a un firmante',
      description: [
        'Envía un enlace de firma nuevo al correo del firmante con ese `email`. El enlace anterior deja de servir. La respuesta no incluye el enlace.',
        'Puedes reenviar una vez cada 10 minutos y hasta diez veces al día por firmante.',
        '**Permiso:** `DOCUMENT.CREATE` con alcance `ORGANIZATION`.',
        'Sustituye a `POST /documents/{documentId}/collaborators/{collaboratorId}/resend-invitation`, que ahora responde `410 INTEGRATION_ENDPOINT_RETIRED`.',
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
      description:
        'Invitación nueva emitida. Si `emailDelivered` es `false`, el correo no salió: vuelve a intentarlo pasados 10 minutos.',
      type: IntegrationResentInvitationResponse,
      example: {
        success: true,
        message: 'Invitación reenviada al correo del firmante',
        data: {
          email: 'luis.martinez@correo.example',
          invitationExpiresAt: '2026-11-02T12:00:00.000Z',
          emailDelivered: true,
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
        '`INTEGRATION_INVITATION_NOT_RESENDABLE`: el firmante ya firmó o rechazó, el documento ya no espera firmas, todavía no es su turno o firma desde su cuenta de Firmalo. `INTEGRATION_AMBIGUOUS_SIGNER`: más de un firmante tiene ese correo.',
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
        '`TOO_MANY_REQUESTS`: ya reenviaste la invitación en los últimos 10 minutos o llegaste a diez reenvíos en el día. Espera antes de volver a intentarlo.',
      type: IntegrationErrorResponseDto,
      examples: { tooManyRequests: TOO_MANY_REQUESTS_EXAMPLE },
    }),
  );
}
