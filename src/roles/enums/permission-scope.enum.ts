/**
 * Alcance de una Permission. Hoy el seed solo usa ANY (sin distinción de
 * "propio" vs. "de cualquiera"); la columna es varchar (no enum a nivel de
 * base) para poder agregar valores nuevos (p. ej. OWN) sin una migración.
 */
export enum PERMISSION_SCOPE_ENUM {
  ANY = 'ANY',
}
