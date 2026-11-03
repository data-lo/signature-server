import type { Request } from 'express';

import { UNKNOWN_ERROR_TYPE, UNMATCHED_ROUTE_LABEL } from './metrics.constants';

/**
 * Excepción observada en cada petición en curso. La medición se cierra cuando termina la respuesta
 * y para entonces la excepción ya no está a la vista, así que quien la ve la anota aquí. Con un
 * `WeakMap` la anotación muere junto con la petición y no se le agregan campos al `Request`.
 */
const httpErrorTypes = new WeakMap<object, string>();

/**
 * Anota el tipo de la excepción que produjo la respuesta de error de una petición.
 *
 * Se guarda sólo el nombre de la clase, nunca el mensaje: puede traer datos personales y su
 * cardinalidad no tiene límite.
 *
 * @param request - Petición en curso.
 * @param exception - Lo que se lanzó al atenderla.
 * @returns Nada.
 *
 * @example
 * ```ts
 * setHttpErrorType(request, new UnauthorizedException()); // 'UnauthorizedException'
 * ```
 */
export function setHttpErrorType(request: object, exception: unknown): void {
  const name =
    exception instanceof Object ? exception.constructor?.name : undefined;

  httpErrorTypes.set(
    request,
    name && /^\w+$/.test(name) ? name : UNKNOWN_ERROR_TYPE,
  );
}

/**
 * Devuelve el tipo de excepción anotado en una petición.
 *
 * @param request - Petición atendida.
 * @returns El nombre de la clase, o `undefined` si nadie observó una excepción.
 *
 * @example
 * ```ts
 * getHttpErrorType(request); // 'UnauthorizedException'
 * ```
 */
export function getHttpErrorType(request: object): string | undefined {
  return httpErrorTypes.get(request);
}

/**
 * Obtiene el label `route` de una petición: la plantilla de Express, nunca la URL real.
 *
 * @param request - Petición en curso o ya atendida.
 * @returns La plantilla (`/api/v1/document/:id`), o `unmatched` si ningún controlador la resolvió.
 *
 * @example
 * ```ts
 * resolveRouteLabel(request); // '/api/v1/document/:id'
 * ```
 */
export function resolveRouteLabel(request: Pick<Request, 'route'>): string {
  const path: unknown = request.route?.path;

  return typeof path === 'string' ? path : UNMATCHED_ROUTE_LABEL;
}
