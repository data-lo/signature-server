import { Injectable, NestMiddleware } from '@nestjs/common';
import { randomUUID } from 'crypto';
import type { NextFunction, Request, Response } from 'express';

import {
  REQUEST_ID_HEADER,
  REQUEST_ID_PATTERN,
} from './request-context.constants';
import { RequestContext } from './request-context.interface';
import { RequestContextService } from './request-context.service';

/**
 * Abre el contexto de correlación de cada petición HTTP y fija `X-Request-Id` en la respuesta.
 *
 * Se monta con `applyRequestContext` en `main.ts`, como middleware de Express y antes que
 * cualquier otro: así corre antes de los parsers de body, del ruteo, de los middleware de módulo
 * (`HttpMetricsMiddleware`), de los guards y de los interceptores, y el header ya está puesto
 * cuando un guard responde 401/403, un `ThrottlerGuard` 429, un pipe 400/422 o un filtro 500.
 *
 * Del cliente sólo lee `X-Request-Id`; cualquier otro header de correlación (`traceparent`,
 * `X-Correlation-Id`…) se ignora por ahora.
 */
@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  constructor(private readonly requestContext: RequestContextService) {}

  /**
   * Resuelve el identificador, lo escribe en la respuesta y continúa la cadena dentro del
   * contexto.
   *
   * @param request - Petición entrante.
   * @param response - Respuesta en curso.
   * @param next - Continúa con la cadena de Express.
   * @returns Nada.
   *
   * @example
   * ```ts
   * const middleware = new RequestContextMiddleware(new RequestContextService());
   * app.use((req, res, next) => middleware.use(req, res, next));
   * ```
   */
  use(request: Request, response: Response, next: NextFunction): void {
    const context: RequestContext = Object.freeze({
      requestId: resolveRequestId(request.headers['x-request-id']),
      method: request.method,
      path: initialPathOf(request.originalUrl ?? request.url),
      startedAt: new Date().toISOString(),
    });

    response.setHeader(REQUEST_ID_HEADER, context.requestId);
    this.requestContext.run(context, () => next());
  }
}

/**
 * El identificador de correlación de una petición: el que mandó el cliente si cumple
 * `REQUEST_ID_PATTERN`, o un UUID v4 nuevo si falta, está vacío, es demasiado largo, trae
 * caracteres no permitidos o vino repetido.
 *
 * @param header - Valor crudo de `request.headers['x-request-id']`.
 * @returns El identificador a usar.
 *
 * @example
 * ```ts
 * resolveRequestId('erp-7f3c2a'); // 'erp-7f3c2a'
 * resolveRequestId('con espacios'); // '2b9c…' (UUID nuevo)
 * resolveRequestId(undefined); // '9d41…' (UUID nuevo)
 * ```
 */
export function resolveRequestId(
  header: string | string[] | undefined,
): string {
  return typeof header === 'string' && REQUEST_ID_PATTERN.test(header)
    ? header
    : randomUUID();
}

/**
 * La ruta de una URL de petición sin query string ni fragmento: la query puede traer datos
 * personales (`?email=…`, `?creatorEmail=…`) que no deben quedar en el contexto.
 *
 * @param url - `request.originalUrl` (o `request.url`).
 * @returns Sólo la ruta.
 *
 * @example
 * ```ts
 * initialPathOf('/api/v1/integration/users/documents?email=ana@correo.test'); // '/api/v1/integration/users/documents'
 * ```
 */
export function initialPathOf(url: string): string {
  return url.split(/[?#]/, 1)[0];
}
