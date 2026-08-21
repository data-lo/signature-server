import { applyDecorators } from '@nestjs/common';
import { ApiOperation, ApiResponse } from '@nestjs/swagger';
import { ResendOtpResponse } from '../interfaces/response/auth-response';
import {
  ConflictResponse,
  NotFoundResponse,
} from 'src/interfaces/api-response.dto';

/** `POST /auth/resend-otp` — reemite el código del registro pendiente. */
export function ApiResendOtp() {
  return applyDecorators(
    ApiOperation({ summary: 'Reenvía el OTP de registro pendiente' }),
    ApiResponse({ status: 200, type: ResendOtpResponse }),
    ApiResponse({ status: 404, type: NotFoundResponse }),
    ApiResponse({ status: 409, type: ConflictResponse }),
  );
}
