import { applyDecorators } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse } from '@nestjs/swagger';
import {
  BadRequestResponse,
  NotFoundResponse,
} from 'src/interfaces/api-response.dto';

/** `DELETE /document/:id` — baja del documento mientras sigue en estatus CREATED. */
export function ApiDeleteDocument() {
  return applyDecorators(
    ApiOperation({ summary: 'Eliminar documento (solo estatus CREATED)' }),
    ApiParam({ name: 'id', description: 'UUID del documento', format: 'uuid' }),
    ApiResponse({
      status: 200,
      description: 'Documento eliminado correctamente',
    }),
    ApiResponse({
      status: 400,
      description: 'El documento no está en estatus CREATED',
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
