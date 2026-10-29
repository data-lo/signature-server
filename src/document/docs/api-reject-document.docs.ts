import { applyDecorators } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiParam, ApiResponse } from '@nestjs/swagger';
import { RejectDocumentDto } from '../dto/reject-document.dto';
import {
  BadRequestResponse,
  NotFoundResponse,
} from 'src/interfaces/api-response.dto';

/** `PATCH /document/:id/reject` — rechazo con motivo, en el turno del firmante. */
export function ApiRejectDocument() {
  return applyDecorators(
    ApiOperation({
      summary:
        'Rechazar el documento con un motivo (solo si es tu turno como firmante)',
    }),
    ApiParam({ name: 'id', description: 'UUID del documento', format: 'uuid' }),
    ApiBody({ type: RejectDocumentDto }),
    ApiResponse({
      status: 200,
      description: 'Documento rechazado correctamente',
    }),
    ApiResponse({
      status: 400,
      description:
        'El documento no se encuentra en estatus PENDING o ya respondiste',
      type: BadRequestResponse,
    }),
    ApiResponse({
      status: 401,
      description:
        'Token de autenticación inválido, expirado o no proporcionado',
    }),
    ApiResponse({
      status: 403,
      description: 'No eres firmante de este documento o no es tu turno',
    }),
    ApiResponse({
      status: 404,
      description: 'Documento no encontrado',
      type: NotFoundResponse,
    }),
  );
}
