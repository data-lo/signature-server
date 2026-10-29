import { applyDecorators } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiParam, ApiResponse } from '@nestjs/swagger';
import { VerifyCodeDto } from '../dto/verify-code.dto';
import { BadRequestResponse } from 'src/interfaces/api-response.dto';

/** `POST /document/:id/verification-codes/verify` — consume el OTP de firma. */
export function ApiVerifyDocumentCode() {
  return applyDecorators(
    ApiOperation({ summary: 'Validar el código de verificación recibido' }),
    ApiParam({ name: 'id', description: 'UUID del documento', format: 'uuid' }),
    ApiBody({ type: VerifyCodeDto }),
    ApiResponse({
      status: 201,
      description: 'Código verificado correctamente',
    }),
    ApiResponse({
      status: 400,
      description: 'Código inválido, expirado o ya usado',
      type: BadRequestResponse,
    }),
    ApiResponse({
      status: 401,
      description:
        'Token de autenticación inválido, expirado o no proporcionado',
    }),
    ApiResponse({
      status: 403,
      description: 'No eres firmante de este documento',
    }),
  );
}
