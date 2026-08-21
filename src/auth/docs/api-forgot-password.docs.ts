import { applyDecorators } from '@nestjs/common';
import { ApiOperation, ApiResponse } from '@nestjs/swagger';
import { ForgotPasswordResponse } from '../interfaces/response/auth-response';

/** `POST /auth/forgot-password` — solicita el OTP de recuperación. */
export function ApiForgotPassword() {
  return applyDecorators(
    ApiOperation({
      summary:
        'Solicita un código OTP de recuperación de contraseña (mensaje genérico siempre, anti-enumeración)',
    }),
    ApiResponse({ status: 200, type: ForgotPasswordResponse }),
  );
}
