import { IntegrationAccessAnnotations } from './integration-access-log.interface';

/**
 * Anotaciones de cada petición en curso. El log se escribe al cerrarse la respuesta, cuando el
 * resultado del controller o la excepción ya no están a la vista: quien los ve anota aquí lo que
 * el log necesita. Con un `WeakMap` la anotación muere con la petición y no se le agregan campos
 * al `Request` —el mismo criterio que `setHttpErrorType` de métricas, pero aparte: lo que se anota
 * aquí no debe llegar nunca a las labels de Prometheus—.
 */
const annotations = new WeakMap<object, IntegrationAccessAnnotations>();

/**
 * Anota datos de la petición para su log de acceso, sumándolos a lo ya anotado.
 *
 * Sólo acepta los campos de `IntegrationAccessAnnotations`; aun así, el formato de cada uno se
 * valida al armar el evento (`buildIntegrationAccessLogEvent`), así que un valor inesperado se
 * descarta en vez de llegar al log.
 *
 * @param request - Petición en curso.
 * @param values - Campos a anotar.
 * @returns Nada.
 *
 * @example
 * ```ts
 * annotateIntegrationAccess(request, { documentId: result.data.id, idempotencyReplayed: true });
 * ```
 */
export function annotateIntegrationAccess(
  request: object,
  values: IntegrationAccessAnnotations,
): void {
  annotations.set(request, { ...annotations.get(request), ...values });
}

/**
 * Lo anotado para el log de acceso de una petición.
 *
 * @param request - Petición atendida.
 * @returns Las anotaciones, o un objeto vacío si nadie anotó nada.
 *
 * @example
 * ```ts
 * getIntegrationAccessAnnotations(request).errorCode; // 'API_KEY_INVALID'
 * ```
 */
export function getIntegrationAccessAnnotations(
  request: object,
): IntegrationAccessAnnotations {
  return annotations.get(request) ?? {};
}

/**
 * El nombre de la clase de una excepción, apto para el log: sólo `\w`, hasta 64 caracteres.
 *
 * @param exception - Lo que se lanzó.
 * @returns El nombre (`InvalidApiKeyException`), o `undefined` si no tiene uno utilizable.
 *
 * @example
 * ```ts
 * errorTypeOf(new UnauthorizedException()); // 'UnauthorizedException'
 * errorTypeOf('texto'); // 'String'
 * ```
 */
export function errorTypeOf(exception: unknown): string | undefined {
  const name =
    exception instanceof Object ? exception.constructor?.name : undefined;
  return name && /^\w{1,64}$/.test(name) ? name : undefined;
}
