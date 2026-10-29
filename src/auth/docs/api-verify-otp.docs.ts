import { applyDecorators } from '@nestjs/common';
import { ApiOperation, ApiResponse } from '@nestjs/swagger';
import { LoginResponse } from '../interfaces/response/auth-response';
import {
  ConflictResponse,
  NotFoundResponse,
} from 'src/interfaces/api-response.dto';

/** `POST /auth/verify-otp` — activa la cuenta y devuelve sesión. */
export function ApiVerifyOtp() {
  return applyDecorators(
    ApiOperation({
      summary: 'Verifica el OTP de registro y activa la cuenta (auto-login)',
    }),
    ApiResponse({ status: 200, type: LoginResponse }),
    ApiResponse({ status: 404, type: NotFoundResponse }),
    ApiResponse({ status: 409, type: ConflictResponse }),
  );
}
