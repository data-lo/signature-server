/**
 * Base del frontend, normalizada. Única fuente de `FRONTEND_URL` para todo el backend.
 *
 * Vive en `common/` y no junto a los enlaces de documentos porque la variable es transversal: la
 * consumen los correos de firma, las invitaciones a organización, las URLs de retorno de Stripe y
 * el origin de CORS. Cada uno leía `process.env.FRONTEND_URL` por su cuenta y solo el de
 * documentos quitaba la diagonal final, así que un valor con `/` al final —que es lo natural de
 * escribir en un panel de despliegue— generaba `.../join` bien pero `...//join` mal, según quién
 * armara el enlace. Peor en CORS: el header `Origin` que manda el navegador NUNCA lleva diagonal
 * final, así que `https://app.ejemplo.com/` no casa con `https://app.ejemplo.com` y el navegador
 * bloquea cada petición sin que el servidor registre ningún error.
 *
 * Deliberadamente NO se usa un host interno de Docker (`http://frontend:3000`) como fallback:
 * estas URLs se abren desde el cliente de correo del destinatario, donde un hostname de red
 * interna es irresoluble y el enlace queda muerto aunque el correo se haya enviado bien.
 */
const DEFAULT_FRONTEND_URL = 'http://localhost:3001';

/** Base del frontend sin diagonales finales, para no generar URLs con `//`. */
export function frontendBaseUrl(): string {
  const configured = process.env.FRONTEND_URL?.trim();
  return (configured || DEFAULT_FRONTEND_URL).replace(/\/+$/, '');
}

/**
 * Base pública de la aplicación web: la que va en los enlaces que se entregan a terceros o se
 * imprimen (la URL de consulta que devuelve la API de integración, el QR de la hoja de firmas).
 *
 * Sale de `PUBLIC_WEB_APP_URL` y, si no está, de `FRONTEND_URL`: en la mayoría de los entornos son
 * la misma app, y así nada cambia mientras la variable nueva no se configure. Nunca se arma con el
 * header `Host` de la petición, que lo controla quien llama.
 *
 * @returns La base sin diagonales finales.
 *
 * @example
 * ```ts
 * // PUBLIC_WEB_APP_URL=https://app.firmalo.com/
 * publicWebAppBaseUrl(); // 'https://app.firmalo.com'
 * ```
 */
export function publicWebAppBaseUrl(): string {
  const configured = process.env.PUBLIC_WEB_APP_URL?.trim();
  return configured ? configured.replace(/\/+$/, '') : frontendBaseUrl();
}
