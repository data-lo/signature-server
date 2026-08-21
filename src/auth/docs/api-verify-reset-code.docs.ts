import { applyDecorators } from '@nestjs/common';
import { ApiOperation, ApiResponse } from '@nestjs/swagger';
import { VerifyResetCodeResponse } from '../interfaces/response/auth-response';
import { BadRequestResponse } from 'src/interfaces/api-response.dto';

/** `POST /auth/verify-reset-code` — valida el OTP de recuperación. */
export function ApiVerifyResetCode() {
  return applyDecorators(
    ApiOperation({ summary: 'Valida el OTP de recuperación de contraseña' }),
    ApiResponse({ status: 200, type: VerifyResetCodeResponse }),
    ApiResponse({ status: 400, type: BadRequestResponse }),
  );
}
