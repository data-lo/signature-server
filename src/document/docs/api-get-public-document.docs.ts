import { applyDecorators } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse } from '@nestjs/swagger';
import { DocumentPublicViewResponse } from '../interfaces/responses/document-public-view-response';
import { NotFoundResponse } from 'src/interfaces/api-response.dto';

/** `GET /document/public/:id` — vista pública del documento, sin autenticación. */
export function ApiGetPublicDocument() {
  return applyDecorators(
    ApiOperation({
      summary: 'Vista pública de un documento (sin autenticación)',
      description:
        'Público (sin JWT ni x-api-key, ver SkipJwtAuth) — usado por /public/documents/:id en el frontend. Solo devuelve secureUrl cuando el documento está SIGNED; para cualquier otro estatus, secureUrl/expiresIn son null y el frontend muestra el aviso correspondiente según el estatus recibido.',
    }),
    ApiParam({ name: 'id', description: 'UUID del documento', format: 'uuid' }),
    ApiResponse({
      status: 200,
      description: 'Documento obtenido correctamente',
      type: DocumentPublicViewResponse,
    }),
    ApiResponse({
      status: 404,
      description: 'Documento no encontrado',
      type: NotFoundResponse,
    }),
  );
}
