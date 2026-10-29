import { applyDecorators } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse } from '@nestjs/swagger';
import {
  BadRequestResponse,
  NotFoundResponse,
} from 'src/interfaces/api-response.dto';

/** `PATCH /document/:id/submit-for-cancellation` — solicita la cancelación de un firmado. */
export function ApiSubmitDocumentForCancellation() {
  return applyDecorators(
    ApiOperation({ summary: 'Enviar documento a cancelación' }),
    ApiParam({ name: 'id', description: 'UUID del documento', format: 'uuid' }),
    ApiResponse({
      status: 200,
      description:
        'Solicitud de cancelación enviada exitosamente, firmantes notificados por correo',
    }),
    ApiResponse({
      status: 400,
      description: 'El documento no se encuentra en estatus SIGNED',
      type: BadRequestResponse,
    }),
    ApiResponse({
      status: 401,
      description:
        'Token de autenticación inválido, expirado o no proporcionado',
    }),
    ApiResponse({
      status: 403,
      description: 'El documento no pertenece al usuario autenticado',
    }),
    ApiResponse({
      status: 404,
      description: 'Documento no encontrado',
      type: NotFoundResponse,
    }),
  );
}
