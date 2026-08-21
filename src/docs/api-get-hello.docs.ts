import { applyDecorators } from '@nestjs/common';
import { ApiExcludeEndpoint } from '@nestjs/swagger';

/**
 * `GET /` — endpoint de sanidad del andamiaje de Nest.
 *
 * Deliberadamente OCULTO del Swagger publicado: no forma parte del contrato de la API. El
 * decorador existe —en vez de dejar `ApiExcludeEndpoint` suelto en el controlador— para que todos
 * los endpoints del proyecto se lean igual y el motivo de la exclusión quede escrito.
 */
export function ApiGetHello() {
  return applyDecorators(ApiExcludeEndpoint());
}
