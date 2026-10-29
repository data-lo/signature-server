import { applyDecorators } from '@nestjs/common';
import { ApiOperation, ApiResponse } from '@nestjs/swagger';

/** `GET /api/v1/signature-capture-sessions/:id` */
export function ApiGetSignatureCaptureSession() {
  return applyDecorators(
    ApiOperation({
      summary: 'Consultar el estado de una captura de firma',
      description:
        'Devuelve en qué va el intento y el estado global de la credencial del usuario. Es el endpoint que la computadora sondea mientras el usuario firma en el teléfono: cuando responde COMPLETED, la pantalla puede continuar sin reiniciar el flujo. Consultar también materializa el vencimiento, así que una captura caducada se reporta como EXPIRED. Nunca devuelve el token del QR.',
    }),
    ApiResponse({ status: 200, description: 'Estado actual de la captura.' }),
    ApiResponse({
      status: 403,
      description: 'La captura pertenece a otro usuario.',
    }),
    ApiResponse({ status: 404, description: 'La captura no existe.' }),
  );
}
