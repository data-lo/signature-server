/**
 * Base del frontend, normalizada. Única fuente de `FRONTEND_URL` para todo el backend.
 *
 * Vive en `shared/` y no junto a los enlaces de documentos porque la variable es transversal: la
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
