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
  integrationErrorExample,
  TOO_MANY_REQUESTS_EXAMPLE,
} from './api-integration-examples.docs';

/**
 * `POST /api/v1/integration/documents/:documentId/collaborators/:collaboratorId/resend-invitation`.
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
        'Requiere `DOCUMENT.CREATE`. Emite una invitación nueva (`/sign/:token`) y la envía al correo del firmante; la anterior deja de servir. El enlace nunca se devuelve. A lo sumo una cada 10 minutos y diez por día por firmante.',
    }),
    ApiParam({
      name: 'documentId',
      format: 'uuid',
      example: '2be3b9d7-4c5d-4e6f-8a9b-0c1d2e3f4a5b',
    }),
    ApiParam({
      name: 'collaboratorId',
      format: 'uuid',
      example: '5c6d7e8f-9a0b-4c1d-8e2f-3a4b5c6d7e8f',
    }),
    ApiIntegrationCommonResponses('DOCUMENT.CREATE'),
    ApiResponse({
      status: 200,
      description:
        'Invitación emitida. Con `emailDelivered: false` la invitación existe pero el correo no salió; se puede reintentar.',
      type: IntegrationResentInvitationResponse,
    }),
    ApiResponse({
      status: 404,
      description:
        '`INTEGRATION_SIGNER_NOT_FOUND`: el documento no es de la organización o el colaborador no es su firmante',
      type: IntegrationErrorResponseDto,
      examples: { signerNotFound: SIGNER_NOT_FOUND_EXAMPLE },
    }),
    ApiResponse({
      status: 409,
      description:
        '`INTEGRATION_INVITATION_NOT_RESENDABLE`: el documento ya no espera esa firma, no es su turno o firma desde su cuenta',
      type: IntegrationErrorResponseDto,
      examples: {
        notResendable: NOT_RESENDABLE_EXAMPLE,
        notInTurn: integrationErrorExample(
          'No es su turno',
          'INTEGRATION_INVITATION_NOT_RESENDABLE',
          'Todavía no es el turno de este firmante',
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
