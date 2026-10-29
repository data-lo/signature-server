/**
 * Estado de UN intento de captura, no del usuario.
 *
 * La distinción importa: el avance del usuario vive en `users.signing_credential_status` y sólo
 * lo escribe `UpdateSigningCredentialStatusUseCase`. Esta tabla es el historial de intentos —
 * quién abrió una captura, desde dónde, si el teléfono llegó a reclamarla y en qué terminó— y
 * ningún estado de acá otorga por sí solo la credencial de firma.
 */
export enum SIGNATURE_CAPTURE_SESSION_STATUS_ENUM {
  /** Sesión abierta y esperando la firma. Es el único estado desde el que se puede reclamar. */
  PENDING = 'PENDING',
  /** El teléfono canjeó el token del QR: el intento quedó atado a ese dispositivo. */
  CLAIMED = 'CLAIMED',
  /** Llegó el PNG y quedó registrado como la firma del usuario. Terminal. */
  COMPLETED = 'COMPLETED',
  /** Venció `expiresAt` sin recibir la firma. Terminal. */
  EXPIRED = 'EXPIRED',
  /** La canceló el usuario, o la sustituyó una sesión nueva. Terminal. */
  CANCELLED = 'CANCELLED',
}

/**
 * Estados en los que la sesión sigue viva: acepta reclamos, firmas y cancelaciones.
 *
 * Es también la condición del índice único parcial que garantiza una sola sesión activa por
 * usuario, así que cualquier cambio acá tiene que replicarse en la migración
 * `CreateSignatureCaptureSessions1784300000030`.
 */
export const ACTIVE_SIGNATURE_CAPTURE_STATUSES: readonly SIGNATURE_CAPTURE_SESSION_STATUS_ENUM[] =
  [
    SIGNATURE_CAPTURE_SESSION_STATUS_ENUM.PENDING,
    SIGNATURE_CAPTURE_SESSION_STATUS_ENUM.CLAIMED,
  ];
