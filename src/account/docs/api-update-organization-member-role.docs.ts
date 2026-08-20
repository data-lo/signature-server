import { applyDecorators } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse } from '@nestjs/swagger';
import { AccountMemberResponse } from '../interfaces/response/account-member-response';

/** `PATCH /api/v1/organizations/members/:accountId/role` — cambio de rol de un miembro. */
export function ApiUpdateOrganizationMemberRole() {
  return applyDecorators(
    ApiOperation({
      summary: 'Cambiar el rol de un miembro',
      description:
        'Solo un ADMIN activo de esa organización puede hacerlo. Rechaza degradar al único ADMIN activo (dejaría la organización sin administrador).',
    }),
    ApiParam({
      name: 'accountId',
      description: 'UUID de la membresía (accountId) a actualizar',
      format: 'uuid',
    }),
    ApiResponse({
      status: 200,
      description: 'Rol actualizado correctamente',
      type: AccountMemberResponse,
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
    ApiResponse({
      status: 409,
      description:
        'El miembro objetivo es el único ADMIN activo de la organización',
    }),
  );
}
