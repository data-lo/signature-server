import { applyDecorators } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse } from '@nestjs/swagger';
import { OrganizationInvitationPreviewResponse } from '../interfaces/response/organization-invitation-response';
import { NotFoundResponse } from 'src/interfaces/api-response.dto';

/** `GET /api/v1/organizations/invitations/:token` — a qué organización invita un enlace. */
export function ApiGetInvitationPreview() {
  return applyDecorators(
    ApiOperation({
      summary: 'Consultar una invitación por su token',
      description:
        'Público (sin JWT) — usado por /join en el frontend para mostrar a qué organización invita el enlace antes de pedir el RFC.',
    }),
    ApiParam({ name: 'token', description: 'Token de la invitación' }),
    ApiResponse({
      status: 200,
      description: 'Invitación obtenida correctamente',
      type: OrganizationInvitationPreviewResponse,
    }),
    ApiResponse({
      status: 404,
      description: 'No existe ninguna invitación con ese token',
      type: NotFoundResponse,
    }),
  );
}
