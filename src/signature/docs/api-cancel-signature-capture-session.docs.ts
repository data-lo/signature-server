import { applyDecorators } from '@nestjs/common';
import { ApiOperation, ApiResponse } from '@nestjs/swagger';

/** `POST /api/v1/signature-capture-sessions/:id/cancel` */
export function ApiCancelSignatureCaptureSession() {
  return applyDecorators(
    ApiOperation({
      summary: 'Cancelar una captura de firma',
      description:
        'Invalida el intento y, con él, el código QR: una captura cancelada no se reclama ni acepta firmas. Libera al usuario para abrir otra sin esperar a que venza. Es idempotente sobre capturas ya canceladas o vencidas; una captura completada no puede cancelarse.',
    }),
    ApiResponse({ status: 201, description: 'Captura cancelada.' }),
    ApiResponse({
      status: 403,
      description: 'La captura pertenece a otro usuario.',
    }),
    ApiResponse({ status: 404, description: 'La captura no existe.' }),
    ApiResponse({
      status: 409,
      description: 'La captura ya se completó y no puede cancelarse.',
    }),
  );
}
