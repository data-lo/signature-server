import type { CookieOptions } from 'express';

/** Cookie de la sesión pública de firma. */
export const PUBLIC_SIGNING_SESSION_COOKIE = 'firmalo_signing_session';

/** Vigencia de la sesión pública: corta a propósito, se renueva validando otro código. */
export const PUBLIC_SIGNING_SESSION_TTL_SECONDS = 30 * 60;

/**
 * Cookie de acceso a una invitación, ANTES de validar el código: la deja el canje del token del
 * correo (`/sign/:token`) o del portal del tercero (`/sign/launch/:token`), y con ella se pide y se
 * valida el código. No da acceso al documento ni a la firma: eso sólo lo da la sesión.
 */
export const PUBLIC_SIGNING_INVITATION_COOKIE = 'firmalo_signing_invitation';

/** Vigencia del acceso a la invitación: lo que tarda en llegar y escribirse el código. */
export const PUBLIC_SIGNING_INVITATION_ACCESS_TTL_SECONDS = 30 * 60;

/**
 * Opciones de la cookie de la sesión pública.
 *
 * - `HttpOnly`: el JavaScript de la página no la lee, así que un XSS no se la lleva.
 * - `Secure`: sólo por HTTPS (los navegadores tratan `localhost` como seguro).
 * - `SameSite=Strict`: otro sitio no puede hacer que el navegador la mande (CSRF).
 * - `Path=/`: el navegador la ve bajo el proxy `/api` de la app, no bajo el path del backend.
 *
 * @param maxAgeMs - Vida de la cookie, en milisegundos; `0` la borra.
 * @returns Las opciones para `response.cookie` / `response.clearCookie`.
 *
 * @throws Nada.
 *
 * @example
 * ```ts
 * response.cookie(PUBLIC_SIGNING_SESSION_COOKIE, token, publicSigningSessionCookieOptions(1_800_000));
 * ```
 */
export function publicSigningSessionCookieOptions(
  maxAgeMs: number,
): CookieOptions {
  return {
    httpOnly: true,
    secure: true,
    sameSite: 'strict',
    path: '/',
    maxAge: maxAgeMs,
  };
}

/**
 * Lee una cookie del header `Cookie` sin depender de `cookie-parser` (el backend no lo usa).
 *
 * @param cookieHeader - Valor del header `Cookie`.
 * @param name - Nombre de la cookie.
 * @returns El valor decodificado, o `null` si no viene.
 *
 * @throws Nada: un valor mal codificado se trata como ausente.
 *
 * @example
 * ```ts
 * readCookie('a=1; firmalo_signing_session=eyJ…', PUBLIC_SIGNING_SESSION_COOKIE); // 'eyJ…'
 * ```
 */
export function readCookie(
  cookieHeader: string | string[] | undefined,
  name: string,
): string | null {
  const header = Array.isArray(cookieHeader)
    ? cookieHeader.join('; ')
    : cookieHeader;
  if (!header) return null;

  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() !== name) continue;
    try {
      const value = decodeURIComponent(part.slice(separator + 1).trim());
      return value || null;
    } catch {
      return null;
    }
  }
  return null;
}
