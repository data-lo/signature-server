import { applyDecorators } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse } from '@nestjs/swagger';
import { NotFoundResponse } from 'src/interfaces/api-response.dto';

/** `GET /document/:id` — detalle para la pantalla de firma. */
export function ApiGetDocument() {
  return applyDecorators(
    ApiOperation({
      summary: 'Obtener el detalle de un documento para la pantalla de firma',
    }),
    ApiParam({ name: 'id', description: 'UUID del documento', format: 'uuid' }),
    ApiResponse({
      status: 200,
      description: 'Detalle del documento obtenido correctamente',
    }),
    ApiResponse({
      status: 401,
      description:
        'Token de autenticación inválido, expirado o no proporcionado',
    }),
    ApiResponse({
      status: 403,
      description: 'No tienes acceso a este documento',
    }),
    ApiResponse({
      status: 404,
      description: 'Documento no encontrado',
      type: NotFoundResponse,
    }),
  );
}
