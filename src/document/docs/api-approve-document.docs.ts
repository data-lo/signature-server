import { applyDecorators } from '@nestjs/common';
import { ApiOperation, ApiResponse } from '@nestjs/swagger';

/** `POST /api/v1/documents/:documentId/approval/approve` — el reviewer autoriza la salida a firma. */
export function ApiApproveDocument() {
  return applyDecorators(
    ApiOperation({
      summary: 'Aprobar un documento que requiere aprobación',
      description:
        'Solo el usuario aprobador asignado, y solo mientras el documento esté en PENDING_APPROVAL y su decisión siga pendiente. Al aprobar, el documento pasa a PENDING_SIGNATURE y se incorpora al flujo de firma existente: se notifica al firmante en turno (o a todos, si el documento no es secuencial y la firma es simple).',
    }),
    ApiResponse({
      status: 201,
      description: 'Documento aprobado; queda en PENDING_SIGNATURE',
    }),
    ApiResponse({
      status: 400,
      description:
        'El documento no requiere aprobación, no está en PENDING_APPROVAL, o su aprobador ya registró una decisión',
    }),
    ApiResponse({
      status: 403,
      description: 'Quien llama no es el usuario aprobador asignado',
    }),
    ApiResponse({
      status: 404,
      description: 'El documento no existe o no tiene aprobador asignado',
    }),
  );
}
