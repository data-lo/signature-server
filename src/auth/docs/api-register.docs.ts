import { applyDecorators } from '@nestjs/common';
import { ApiOperation, ApiResponse } from '@nestjs/swagger';
import { RegisterResponse } from '../interfaces/response/auth-response';
import { ConflictResponse } from 'src/interfaces/api-response.dto';

/** `POST /auth/register` — pre-registro público de usuario. */
export function ApiRegister() {
  return applyDecorators(
    ApiOperation({ summary: 'Registro público de usuario (self-service)' }),
    ApiResponse({ status: 201, type: RegisterResponse }),
    ApiResponse({ status: 409, type: ConflictResponse }),
  );
}
