import { applyDecorators } from '@nestjs/common';
import {
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiSecurity,
} from '@nestjs/swagger';
import {
  BaseResponse,
  NotFoundResponse,
} from 'src/interfaces/api-response.dto';

/** `DELETE /user/:id` — baja de un usuario (API pública, ver `ApiCreateUser`). */
export function ApiDeleteUser() {
  return applyDecorators(
    ApiSecurity('x-api-key'),
    ApiOperation({ summary: 'Eliminar usuario' }),
    ApiParam({
      name: 'id',
      description: 'Identificador único del usuario en formato UUID v4',
      format: 'uuid',
      example: '8c388293-6f5e-4e61-8c96-ae36c2fa6faa',
    }),
    ApiResponse({
      status: 200,
      description: 'Usuario eliminado correctamente',
      type: BaseResponse,
    }),
    ApiResponse({
      status: 401,
      description: 'API Key inválida o no proporcionada',
    }),
    ApiResponse({
      status: 404,
      description: 'Usuario no encontrado',
      type: NotFoundResponse,
    }),
  );
}
