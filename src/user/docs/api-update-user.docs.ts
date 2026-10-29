import { applyDecorators } from '@nestjs/common';
import {
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiSecurity,
} from '@nestjs/swagger';
import { UserCreateData } from '../interfaces/response/user-create-response';
import { NotFoundResponse } from 'src/interfaces/api-response.dto';

/** `PATCH /user/:id` — actualización de datos (API pública, ver `ApiCreateUser`). */
export function ApiUpdateUser() {
  return applyDecorators(
    ApiSecurity('x-api-key'),
    ApiOperation({ summary: 'Actualizar datos de un usuario' }),
    ApiParam({
      name: 'id',
      description: 'Identificador único del usuario en formato UUID v4',
      format: 'uuid',
      example: '8c388293-6f5e-4e61-8c96-ae36c2fa6faa',
    }),
    ApiResponse({
      status: 200,
      description: 'Usuario actualizado correctamente',
      type: UserCreateData,
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
