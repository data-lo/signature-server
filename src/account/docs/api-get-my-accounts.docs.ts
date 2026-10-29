import { applyDecorators } from '@nestjs/common';
import { ApiOperation, ApiResponse } from '@nestjs/swagger';
import { AccountListResponse } from '../interfaces/response/account-response';

/** `GET /api/v1/accounts/me` — catálogo de cuentas del usuario autenticado. */
export function ApiGetMyAccounts() {
  return applyDecorators(
    ApiOperation({
      summary: 'Obtener el catálogo de cuentas del usuario autenticado',
      description:
        'Lee exclusivamente desde Redis DB 0 (key accounts:{userId}) el listado unificado de cuentas Personal y Organización del usuario',
    }),
    ApiResponse({
      status: 200,
      description: 'Catálogo de cuentas obtenido correctamente',
      type: AccountListResponse,
    }),
    ApiResponse({
      status: 401,
      description:
        'Token de autenticación inválido, expirado o no proporcionado',
    }),
  );
}
