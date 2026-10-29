import { applyDecorators } from '@nestjs/common';
import {
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiSecurity,
} from '@nestjs/swagger';
import { UserGetResponse } from '../interfaces/response/get-user-response';
import { NotFoundResponse } from 'src/interfaces/api-response.dto';

/** `GET /user/:id` — detalle de un usuario activo (API pública, ver `ApiCreateUser`). */
export function ApiGetUser() {
  return applyDecorators(
    ApiSecurity('x-api-key'),
    ApiOperation({ summary: 'Obtener un usuario' }),
    ApiParam({
      name: 'id',
      description: 'Identificador único del usuario en formato UUID v4',
      format: 'uuid',
      example: '8c388293-6f5e-4e61-8c96-ae36c2fa6faa',
    }),
    ApiQuery({
      name: 'withSignature',
      required: false,
      type: Boolean,
      description: 'Incluir la firma del usuario',
    }),
    ApiResponse({
      status: 200,
      description: 'Usuario encontrado',
      type: UserGetResponse,
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
