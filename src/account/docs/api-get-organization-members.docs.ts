import { applyDecorators } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiResponse } from '@nestjs/swagger';
import { AccountMemberListResponse } from '../interfaces/response/account-member-response';

/** `GET /account-member?organizationId=` — miembros de una organización. */
export function ApiGetOrganizationMembers() {
  return applyDecorators(
    ApiOperation({
      summary: 'Obtener los miembros de una organización',
      description:
        'Solo un ADMIN activo de esa organización puede listar sus miembros.',
    }),
    ApiQuery({
      name: 'organizationId',
      required: true,
      type: String,
      description: 'UUID de la organización',
    }),
    ApiResponse({
      status: 200,
      description: 'Lista de miembros obtenida correctamente',
      type: AccountMemberListResponse,
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
