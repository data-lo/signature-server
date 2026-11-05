import { applyDecorators } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse } from '@nestjs/swagger';
import { NotFoundResponse } from 'src/interfaces/api-response.dto';

/** `POST /document/:id/archive` — archiva un documento para el usuario autenticado. */
export function ApiArchiveDocument() {
  return applyDecorators(
    ApiOperation({
      summary: 'Archivar un documento',
      description:
        'Oculta el documento del listado DEL USUARIO AUTENTICADO, sea cual sea su estatus. No ' +
        'cambia el estatus del documento ni afecta su flujo ni a los demás participantes. Es ' +
        'idempotente: archivar ' +
        'dos veces no falla ni duplica la preferencia, sólo actualiza la fecha. Requiere ' +
        'DOCUMENT.READ y se autoriza igual que el detalle: con DOCUMENT.READ_ORGANIZATION se ' +
        'archiva cualquier documento de la organización aunque no se haya creado; con ' +
        'DOCUMENT.READ_OWN, sólo los propios o donde se participa.',
    }),
    ApiParam({ name: 'id', description: 'UUID del documento', format: 'uuid' }),
    ApiResponse({
      status: 201,
      description: 'Documento archivado correctamente',
    }),
    ApiResponse({
      status: 401,
      description:
        'Token de autenticación inválido, expirado o no proporcionado',
    }),
    ApiResponse({
      status: 403,
      description:
        'El rol de la cuenta activa no tiene DOCUMENT.READ, o ninguno de sus alcances cubre ' +
        'este documento',
    }),
    ApiResponse({
      status: 404,
      description: 'Documento no encontrado',
      type: NotFoundResponse,
    }),
  );
}
