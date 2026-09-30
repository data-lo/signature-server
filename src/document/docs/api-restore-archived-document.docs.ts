import { applyDecorators } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse } from '@nestjs/swagger';
import { NotFoundResponse } from 'src/interfaces/api-response.dto';

/** `DELETE /document/:id/archive` — devuelve un documento archivado a la bandeja del usuario. */
export function ApiRestoreArchivedDocument() {
  return applyDecorators(
    ApiOperation({
      summary: 'Recuperar un documento archivado',
      description:
        'Quita el documento de los archivados DEL USUARIO AUTENTICADO y lo devuelve a su ' +
        'listado. No cambia el documento ni afecta a lo que otros participantes archivaron. Es ' +
        'idempotente: recuperar un documento que no estaba archivado responde igual. Requiere ' +
        'DOCUMENT.READ y se autoriza igual que el detalle y que archivar.',
    }),
    ApiParam({ name: 'id', description: 'UUID del documento', format: 'uuid' }),
    ApiResponse({
      status: 200,
      description: 'Documento recuperado correctamente',
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
