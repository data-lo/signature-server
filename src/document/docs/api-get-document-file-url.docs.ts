import { applyDecorators } from '@nestjs/common';
import { ApiExcludeEndpoint } from '@nestjs/swagger';

/**
 * `GET /document/file/:id` — URL prefirmada del archivo en MinIO.
 *
 * Deliberadamente OCULTO del Swagger publicado: es una ruta de consumo interno del frontend, no
 * parte del contrato que se documenta hacia afuera. El decorador existe —en vez de dejar
 * `ApiExcludeEndpoint` suelto en el controlador— para que el motivo quede escrito en algún lado y
 * para que todos los endpoints del módulo se lean igual.
 */
export function ApiGetDocumentFileUrl() {
  return applyDecorators(ApiExcludeEndpoint());
}
