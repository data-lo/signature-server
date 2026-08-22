import { applyDecorators } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse } from '@nestjs/swagger';
import { OrganizationMemberListResponse } from '../interfaces/response/account-member-response';

/** `GET /api/v1/organizations/:organizationId/members` — miembros con su detalle. */
export function ApiGetOrganizationMemberList() {
  return applyDecorators(
    ApiOperation({
      summary: 'Listar los miembros de una organización',
      description:
        'Email, RFC, rol asignado y fecha de ingreso de cada miembro activo. Solo un miembro con permiso ORGANIZATION:READ (rol ADMIN) puede listarlos.',
    }),
    ApiParam({
      name: 'organizationId',
      description: 'UUID de la organización',
      format: 'uuid',
    }),
    ApiResponse({
      status: 200,
      description: 'Lista de miembros obtenida correctamente',
      type: OrganizationMemberListResponse,
    }),
    ApiResponse({
      status: 401,
      description:
        'Token de autenticación inválido, expirado o no proporcionado',
    }),
    ApiResponse({
      status: 403,
      description: 'El usuario autenticado no es ADMIN de esta organización',
    }),
  );
}
