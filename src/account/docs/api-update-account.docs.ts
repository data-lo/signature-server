import { applyDecorators } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse } from '@nestjs/swagger';
import { AccountResponse } from '../interfaces/response/account-response';
import { NotFoundResponse } from 'src/interfaces/api-response.dto';

/** `PATCH /account/:id` — actualización de los datos de una cuenta. */
export function ApiUpdateAccount() {
  return applyDecorators(
    ApiOperation({ summary: 'Actualizar datos de una cuenta' }),
    ApiParam({
      name: 'id',
      description: 'Identificador único de la cuenta en formato UUID v4',
      format: 'uuid',
      example: '8c388293-6f5e-4e61-8c96-ae36c2fa6faa',
    }),
    ApiResponse({
      status: 200,
      description: 'Cuenta actualizada correctamente',
      type: AccountResponse,
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
      description: 'Cuenta no encontrada',
      type: NotFoundResponse,
    }),
  );
}
