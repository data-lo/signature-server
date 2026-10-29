import { applyDecorators } from '@nestjs/common';
import { ApiOperation, ApiResponse } from '@nestjs/swagger';
import { ResetPasswordResponse } from '../interfaces/response/auth-response';
import { UnauthorizedResponse } from 'src/interfaces/api-response.dto';

/** `POST /auth/reset-password` — establece la contraseña nueva con el resetToken. */
export function ApiResetPassword() {
  return applyDecorators(
    ApiOperation({
      summary:
        'Establece una nueva contraseña usando el resetToken de /auth/verify-reset-code',
    }),
    ApiResponse({ status: 200, type: ResetPasswordResponse }),
    ApiResponse({ status: 401, type: UnauthorizedResponse }),
  );
}
