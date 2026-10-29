import { applyDecorators } from '@nestjs/common';
import { ApiOperation, ApiResponse } from '@nestjs/swagger';
import { AccountListResponse } from '../interfaces/response/account-response';

/** `GET /account` — listado completo de cuentas. */
export function ApiGetAccounts() {
  return applyDecorators(
    ApiOperation({ summary: 'Obtener todas las cuentas' }),
    ApiResponse({
      status: 200,
      description: 'Lista de cuentas obtenida correctamente',
      type: AccountListResponse,
    }),
    ApiResponse({
      status: 401,
      description:
        'Token de autenticación inválido, expirado o no proporcionado',
    }),
  );
}
