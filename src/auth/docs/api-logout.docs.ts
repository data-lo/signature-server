import { applyDecorators } from '@nestjs/common';
import { ApiOperation, ApiResponse } from '@nestjs/swagger';
import { UnauthorizedResponse } from 'src/interfaces/api-response.dto';

/** `POST /auth/logout` — invalida el token en curso. */
export function ApiLogout() {
  return applyDecorators(
    ApiOperation({ summary: 'Cierra la sesión actual e invalida el token' }),
    ApiResponse({ status: 200, description: 'Sesión cerrada correctamente' }),
    ApiResponse({ status: 401, type: UnauthorizedResponse }),
  );
}
