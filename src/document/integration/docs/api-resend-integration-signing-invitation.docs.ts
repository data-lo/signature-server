import { applyDecorators } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse } from '@nestjs/swagger';

import { IntegrationErrorResponseDto } from '../interfaces/integration-document-response';
import { ApiIntegrationCommonResponses } from './api-integration-documents-common.docs';

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
        'Requiere `DOCUMENT.CREATE_ORGANIZATION`. Emite una invitación nueva (`/sign/:token`) y la envía al correo del firmante; la anterior deja de servir. El enlace nunca se devuelve. A lo sumo una cada 10 minutos y diez por día por firmante.',
    }),
    ApiParam({ name: 'documentId', format: 'uuid' }),
    ApiParam({ name: 'collaboratorId', format: 'uuid' }),
    ApiIntegrationCommonResponses('DOCUMENT.CREATE_ORGANIZATION'),
    ApiResponse({
      status: 200,
      description:
        '{ success, message, data: { collaboratorId, invitationExpiresAt, emailDelivered } }',
    }),
    ApiResponse({
      status: 404,
      description:
        '`INTEGRATION_SIGNER_NOT_FOUND`: el documento no es de la organización o el colaborador no es su firmante',
      type: IntegrationErrorResponseDto,
    }),
    ApiResponse({
      status: 409,
      description:
        '`INTEGRATION_INVITATION_NOT_RESENDABLE`: el documento ya no espera esa firma, no es su turno o firma desde su cuenta',
      type: IntegrationErrorResponseDto,
    }),
    ApiResponse({ status: 429, description: 'Demasiados reenvíos' }),
  );
}
