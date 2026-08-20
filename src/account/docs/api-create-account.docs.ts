import { applyDecorators } from '@nestjs/common';
import { ApiOperation, ApiResponse } from '@nestjs/swagger';
import { AccountResponse } from '../interfaces/response/account-response';
import { BadRequestResponse } from 'src/interfaces/api-response.dto';

/** `POST /account` — alta de un espacio de trabajo. */
export function ApiCreateAccount() {
  return applyDecorators(
    ApiOperation({
      summary: 'Crear nueva cuenta',
      description: 'Crea un nuevo espacio de trabajo personal u organizacional',
    }),
    ApiResponse({
      status: 201,
      description: 'Cuenta creada correctamente',
      type: AccountResponse,
    }),
    ApiResponse({
      status: 400,
      description: 'Los datos enviados son inválidos o incompletos',
      type: BadRequestResponse,
    }),
    ApiResponse({
      status: 401,
      description:
        'Token de autenticación inválido, expirado o no proporcionado',
    }),
  );
}
