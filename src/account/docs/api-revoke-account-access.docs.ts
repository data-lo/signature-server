import { applyDecorators } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse } from '@nestjs/swagger';
import {
  BaseResponse,
  NotFoundResponse,
} from 'src/interfaces/api-response.dto';

/** `DELETE /account-member/:id` — marca el acceso como no vigente. */
export function ApiRevokeAccountAccess() {
  return applyDecorators(
    ApiOperation({
      summary: 'Revocar acceso',
      description:
        'Marca el acceso del usuario a la cuenta como no vigente. Solo un ADMIN activo de esa cuenta puede revocar acceso.',
    }),
    ApiParam({
      name: 'id',
      description: 'Identificador único de la membresía en formato UUID v4',
      format: 'uuid',
      example: '8c388293-6f5e-4e61-8c96-ae36c2fa6faa',
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
      description: 'El usuario autenticado no es ADMIN de esta cuenta',
    }),
    ApiResponse({
      status: 404,
      description: 'Membresía no encontrada',
      type: NotFoundResponse,
    }),
  );
}
