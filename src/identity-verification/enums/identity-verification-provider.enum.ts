/**
 * Proveedor externo que ejecutó la verificación de identidad.
 *
 * Hoy sólo existe Didit, pero el enum (y no una columna implícita) es lo que permite que un
 * segundo proveedor conviva con los intentos históricos sin migrar datos: `provider` es la
 * mitad de la clave `UNIQUE(provider, provider_session_id)`.
 */
export enum IDENTITY_VERIFICATION_PROVIDER_ENUM {
  DIDIT = 'DIDIT',
}
