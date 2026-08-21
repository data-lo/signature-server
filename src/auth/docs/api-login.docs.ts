import { applyDecorators } from '@nestjs/common';
import { ApiOperation, ApiResponse } from '@nestjs/swagger';
import { LoginResponse } from '../interfaces/response/auth-response';
import {
  ForbiddenResponse,
  UnauthorizedResponse,
} from 'src/interfaces/api-response.dto';

/** `POST /auth/login` — inicio de sesión. */
export function ApiLogin() {
  return applyDecorators(
    ApiOperation({ summary: 'Inicio de sesión' }),
    ApiResponse({ status: 200, type: LoginResponse }),
    ApiResponse({ status: 401, type: UnauthorizedResponse }),
    ApiResponse({
      status: 403,
      type: ForbiddenResponse,
      description: 'La cuenta todavía no verifica su correo (pre-registro)',
    }),
  );
}
