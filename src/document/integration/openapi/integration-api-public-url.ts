/** Variable de entorno con el host público de la API de integración. */
export const INTEGRATION_API_PUBLIC_URL_ENV = 'INTEGRATION_API_PUBLIC_URL';

/**
 * Host público de la API de integración, el que va en `servers` del contrato OpenAPI que publica
 * `/api/v1/integration/docs-json`. Mintlify lo usa para mandar las peticiones del playground a la
 * API y no a su propio dominio.
 *
 * Es sólo el origen (`https://host[:puerto]`): las rutas del contrato ya llevan `/api/v1/integration/...`,
 * así que una URL con ruta duplicaría el prefijo. Se quitan las diagonales finales, como en
 * `frontendBaseUrl()`. Nunca se arma con el header `Host` de la petición, que lo controla quien llama.
 *
 * Sin la variable (o vacía) no hay `servers`: Swagger UI usa el host desde el que se abre, que es
 * lo que se quiere en local. Sólo debe configurarse en staging mientras el playground de Mintlify
 * no esté aprobado para producción.
 *
 * @returns El origen sin diagonal final, o `undefined` si la variable no está configurada.
 *
 * @throws {Error} Si la variable no es una URL `http(s)` absoluta o trae ruta, query o fragmento.
 *
 * @example
 * ```ts
 * // INTEGRATION_API_PUBLIC_URL=https://signature.api.staging.data-lo.online/
 * integrationApiPublicUrl(); // 'https://signature.api.staging.data-lo.online'
 * ```
 */
export function integrationApiPublicUrl(): string | undefined {
  const configured = process.env[INTEGRATION_API_PUBLIC_URL_ENV]?.trim();
  if (!configured) return undefined;

  const value = configured.replace(/\/+$/, '');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalidPublicUrl(configured, 'no es una URL absoluta');
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw invalidPublicUrl(configured, 'debe usar http o https');
  }
  if (url.pathname !== '/' || url.search || url.hash) {
    throw invalidPublicUrl(
      configured,
      'debe ser sólo el origen, sin ruta (las rutas ya llevan /api/v1/integration), query ni fragmento',
    );
  }

  return url.origin;
}

/**
 * Error de arranque por un `INTEGRATION_API_PUBLIC_URL` mal configurado.
 *
 * @param value - Valor configurado.
 * @param reason - Qué le falta.
 * @returns El error, para lanzarlo.
 *
 * @example
 * ```ts
 * throw invalidPublicUrl('ftp://host', 'debe usar http o https');
 * ```
 */
function invalidPublicUrl(value: string, reason: string): Error {
  return new Error(
    `${INTEGRATION_API_PUBLIC_URL_ENV} inválida («${value}»): ${reason}.`,
  );
}
