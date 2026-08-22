import { applyDecorators } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiResponse } from '@nestjs/swagger';
import { UserGetListResponse } from '../interfaces/response/get-user-response';

/** `GET /user` — usuarios activos. */
export function ApiGetUsers() {
  return applyDecorators(
    ApiOperation({ summary: 'Obtener todos los usuarios' }),
    ApiQuery({
      name: 'withSignature',
      required: false,
      type: Boolean,
      description: 'Incluir la firma del usuario',
    }),
    ApiResponse({
      status: 200,
      description: 'Lista de usuarios obtenida correctamente',
      type: UserGetListResponse,
    }),
    ApiResponse({
      status: 401,
      description:
        'Token de autenticación inválido, expirado o no proporcionado',
    }),
  );
}
