/**
 * Base del frontend, normalizada: única fuente de `FRONTEND_URL` para todo el backend.
 *
 * Vive en `shared/` porque la variable es transversal —la consumen los correos de firma, las
 * invitaciones a organización, las URLs de retorno de Stripe y el origin de CORS—. Mientras cada uno
 * leía `process.env.FRONTEND_URL` por su cuenta y sólo el de documentos quitaba la diagonal final,
 * un valor terminado en `/` producía `.../join` bien y `...//join` mal según quién armara el enlace.
 * Peor en CORS: el header `Origin` del navegador nunca lleva diagonal final, así que
 * `https://app.ejemplo.com/` no casa y el navegador bloquea cada petición sin que el servidor
 * registre ningún error.
 *
 * NO usa un host interno de Docker como fallback: estas URLs se abren desde el cliente de correo del
 * destinatario, donde un hostname de red interna es irresoluble y el enlace queda muerto.
 */
const DEFAULT_FRONTEND_URL = 'http://localhost:3001';

/** Base del frontend sin diagonales finales, para no generar URLs con `//`. */
export function frontendBaseUrl(): string {
  const configured = process.env.FRONTEND_URL?.trim();
  return (configured || DEFAULT_FRONTEND_URL).replace(/\/+$/, '');
}
