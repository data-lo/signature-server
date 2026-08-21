import { applyDecorators } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse } from '@nestjs/swagger';

/** `POST /document/:id/verification-codes` — emite el OTP de firma (requiresVerification). */
export function ApiRequestVerificationCode() {
  return applyDecorators(
    ApiOperation({
      summary:
        'Solicitar un código de verificación para firmar (documentos con requiresVerification=true)',
    }),
    ApiParam({ name: 'id', description: 'UUID del documento', format: 'uuid' }),
    ApiResponse({
      status: 201,
      description:
        'Código de verificación emitido. `data.emailDelivered` indica si además se pudo enviar por correo: un fallo del proveedor de correo no invalida el código ni bloquea la firma (el firmante puede pedir un reenvío).',
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
