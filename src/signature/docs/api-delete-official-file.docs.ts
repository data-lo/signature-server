import { applyDecorators } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse } from '@nestjs/swagger';
import {
  BadRequestResponse,
  NotFoundResponse,
} from 'src/interfaces/api-response.dto';

/** `DELETE /signature/:id/official-file` — borra solo la identificación oficial. */
export function ApiDeleteOfficialFile() {
  return applyDecorators(
    ApiOperation({
      summary:
        'Eliminar la identificación oficial (INE) del usuario autenticado',
    }),
    ApiParam({
      name: 'id',
      description: 'Identificador único de la firma en formato UUID v4',
      format: 'uuid',
      example: '8c388293-6f5e-4e61-8c96-ae36c2fa6faa',
    }),
    ApiResponse({
      status: 200,
      description: 'Identificación oficial eliminada correctamente',
    }),
    ApiResponse({
      status: 400,
      description: 'No hay una identificación oficial registrada para eliminar',
      type: BadRequestResponse,
    }),
    ApiResponse({
      status: 401,
      description:
        'Token de autenticación inválido, expirado o no proporcionado',
    }),
    ApiResponse({
      status: 403,
      description: 'La firma no pertenece al usuario autenticado',
    }),
    ApiResponse({
      status: 404,
      description: 'No existe una firma registrada con el UUID proporcionado',
      type: NotFoundResponse,
    }),
  );
}
