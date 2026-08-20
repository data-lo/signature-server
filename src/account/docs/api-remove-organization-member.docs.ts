import { applyDecorators } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse } from '@nestjs/swagger';
import { BaseResponse } from 'src/interfaces/api-response.dto';

/** `DELETE /api/v1/organizations/members/:accountId` — soft-delete de la membresía. */
export function ApiRemoveOrganizationMember() {
  return applyDecorators(
    ApiOperation({
      summary: 'Eliminar (revocar acceso de) un miembro de la organización',
      description:
        'Soft-delete: marca la membresía como no vigente. Solo un ADMIN activo de esa organización puede hacerlo. Rechaza eliminar al único ADMIN activo.',
    }),
    ApiParam({
      name: 'accountId',
      description: 'UUID de la membresía (accountId) a eliminar',
      format: 'uuid',
    }),
    ApiResponse({
      status: 200,
      description: 'Acceso revocado correctamente',
      type: BaseResponse,
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
