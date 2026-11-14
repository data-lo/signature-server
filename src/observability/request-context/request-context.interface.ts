/**
 * Contexto de una petición HTTP, disponible durante toda su atención —middleware, guards,
 * interceptores, controller, servicios y lo que éstos esperen con `await`— a través de
 * `RequestContextService`.
 *
 * Es deliberadamente mínimo y sin datos del cliente: no lleva headers (ni la API key, ni
 * `Authorization`, ni `traceparent`), ni query string, ni body, ni archivos. Se congela al
 * crearse para que nadie le agregue nada por el camino.
 *
 * Ojo con `path`: es la ruta tal como llegó, y algunas llevan un token en un parámetro
 * (`/api/v1/sign/:token`, invitaciones a organizaciones). Quien lo registre en un log debe usar la
 * plantilla de la ruta (`resolveRouteLabel`), no este valor.
 */
export interface RequestContext {
  /** Identificador de correlación: el `X-Request-Id` del cliente si era válido, o un UUID nuevo. */
  readonly requestId: string;

  /** Método HTTP (`GET`, `POST`…). */
  readonly method: string;

  /** Ruta inicial de la petición, sin query string ni fragmento. */
  readonly path: string;

  /** Momento en que se recibió la petición, en ISO 8601 (UTC). */
  readonly startedAt: string;
}
