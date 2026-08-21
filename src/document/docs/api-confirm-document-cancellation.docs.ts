import { applyDecorators } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse } from '@nestjs/swagger';
import {
  BadRequestResponse,
  NotFoundResponse,
} from 'src/interfaces/api-response.dto';

/** `PATCH /document/:id/confirm-cancellation` — cualquier firmante confirma la cancelación. */
export function ApiConfirmDocumentCancellation() {
  return applyDecorators(
    ApiOperation({
      summary: 'Confirmar la cancelación de un documento (cualquier firmante)',
    }),
    ApiParam({ name: 'id', description: 'UUID del documento', format: 'uuid' }),
    ApiResponse({
      status: 200,
      description:
        'Documento cancelado correctamente, marca de agua estampada y participantes notificados',
    }),
    ApiResponse({
      status: 400,
      description:
        'El documento no se encuentra en estatus CANCELLATION_PENDING',
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
    ApiResponse({
      status: 404,
      description: 'Documento no encontrado',
      type: NotFoundResponse,
    }),
  );
}
