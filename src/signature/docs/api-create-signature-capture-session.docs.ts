import { applyDecorators } from '@nestjs/common';
import { ApiOperation, ApiResponse } from '@nestjs/swagger';

/** `POST /api/v1/signature-capture-sessions` */
export function ApiCreateSignatureCaptureSession() {
  return applyDecorators(
    ApiOperation({
      summary: 'Iniciar una captura de firma manuscrita',
      description:
        'Abre un intento de captura para el usuario autenticado. Con canal MOBILE_QR devuelve además un token de un solo uso y la URL que el frontend convierte en código QR; ese token sólo se entrega en esta respuesta y en base de datos únicamente queda su hash. Sólo puede haber una captura activa por usuario: si la anterior sigue sin reclamarse, se sustituye; si ya la reclamó un teléfono, se responde 409.',
    }),
    ApiResponse({
      status: 201,
      description: 'Captura de firma abierta y lista para recibir el PNG.',
    }),
    ApiResponse({
      status: 403,
      description:
        'El usuario todavía no tiene la identidad aprobada (no está en SIGNATURE_PENDING) o ya registró su firma.',
    }),
    ApiResponse({
      status: 409,
      description:
        'Ya hay una captura reclamada desde un teléfono y todavía en curso.',
    }),
  );
}
