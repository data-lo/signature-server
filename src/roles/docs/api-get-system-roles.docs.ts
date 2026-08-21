import { applyDecorators } from '@nestjs/common';
import { ApiOperation, ApiResponse } from '@nestjs/swagger';
import { RoleListResponse } from '../interfaces/response/role-response';

/** `GET /api/v1/roles` — roles seed del sistema. */
export function ApiGetSystemRoles() {
  return applyDecorators(
    ApiOperation({
      summary: 'Obtener los roles del sistema',
      description:
        'Retorna los roles seed (isSystemRole = true), p. ej. para poblar el modal de invitación de miembros',
    }),
    ApiResponse({
      status: 200,
      description: 'Roles del sistema obtenidos correctamente',
      type: RoleListResponse,
    }),
    ApiResponse({
      status: 401,
      description:
        'Token de autenticación inválido, expirado o no proporcionado',
    }),
  );
}
