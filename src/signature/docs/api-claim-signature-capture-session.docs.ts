import { applyDecorators } from '@nestjs/common';
import { ApiOperation, ApiResponse } from '@nestjs/swagger';

/** `POST /api/v1/signature-capture-sessions/claim` */
export function ApiClaimSignatureCaptureSession() {
  return applyDecorators(
    ApiOperation({
      summary: 'Reclamar desde el teléfono la captura del código QR',
      description:
        'Canjea el token del QR y ata el intento al teléfono. Exige token de sesión: el usuario autenticado tiene que ser el mismo que generó el código, así que un QR fotografiado por un tercero no le sirve para registrar una firma. El token es de un solo uso — al reclamarse, la sesión pasa a CLAIMED y deja de ser reclamable.',
    }),
    ApiResponse({
      status: 201,
      description:
        'Captura reclamada. El teléfono ya puede enviar el PNG de la firma.',
    }),
    ApiResponse({
      status: 403,
      description:
        'La captura pertenece a otro usuario, o el usuario autenticado no tiene la identidad aprobada.',
    }),
    ApiResponse({
      status: 404,
      description:
        'El token no corresponde a ninguna captura reclamable: no existe, ya se canjeó, se canceló o venció.',
    }),
  );
}
