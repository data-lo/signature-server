import { applyDecorators } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse } from '@nestjs/swagger';
import {
  BadRequestResponse,
  NotFoundResponse,
} from 'src/interfaces/api-response.dto';

/** `POST /document/:id/archive` — archiva un documento firmado para el usuario autenticado. */
export function ApiArchiveDocument() {
  return applyDecorators(
    ApiOperation({
      summary: 'Archivar un documento completado',
      description:
        'Oculta el documento del listado de completados DEL USUARIO AUTENTICADO. No cambia el ' +
        'estatus del documento ni afecta a los demás participantes. Es idempotente: archivar ' +
        'dos veces no falla ni duplica la preferencia, sólo actualiza la fecha.',
    }),
    ApiParam({ name: 'id', description: 'UUID del documento', format: 'uuid' }),
    ApiResponse({
      status: 201,
      description: 'Documento archivado correctamente',
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
      description: 'El usuario autenticado no participa en el documento',
    }),
    ApiResponse({
      status: 404,
      description: 'Documento no encontrado',
      type: NotFoundResponse,
    }),
  );
}
