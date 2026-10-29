/**
 * Estado de un intento de firma biométrica (tabla `biometric_signature_attempts`).
 *
 * Es el estado de la SESIÓN con Didit, no el de la firma: el colaborador sigue en `PENDING`
 * mientras la biometría está en curso, y sólo pasa a `SIGNED` cuando el webhook trae la
 * aprobación. A propósito no existe un `BIOMETRIC_PENDING` en `COLLABORATOR_STATUS_ENUM`: tocar ese
 * enum alteraría el orden secuencial, los filtros de pendientes y las notificaciones.
 */
export enum BIOMETRIC_SIGNATURE_ATTEMPT_STATUS_ENUM {
  /** Fila creada; Didit todavía no responde o el firmante no ha abierto la sesión. */
  PENDING = 'PENDING',
  /** El firmante está capturando, o Didit dejó el resultado en revisión. */
  IN_PROGRESS = 'IN_PROGRESS',
  /** Didit aprobó y la firma quedó (o está quedando) registrada. */
  APPROVED = 'APPROVED',
  /** Didit rechazó la biometría. */
  DECLINED = 'DECLINED',
  /** La sesión venció o el firmante la abandonó. */
  EXPIRED = 'EXPIRED',
  /**
   * No se pudo crear la sesión, Didit reportó algo no reconocido, o la aprobación llegó pero ya no
   * podía firmar (el PDF cambió, dejó de ser su turno…). `failure_reason` dice cuál.
   */
  FAILED = 'FAILED',
}

/**
 * Estados en los que un intento sigue abierto. El índice único parcial
 * `UQ_biometric_signature_attempts_active` usa exactamente esta lista; si cambia aquí, cambia en
 * la migración.
 */
export const ACTIVE_BIOMETRIC_SIGNATURE_ATTEMPT_STATUSES: readonly BIOMETRIC_SIGNATURE_ATTEMPT_STATUS_ENUM[] =
  [
    BIOMETRIC_SIGNATURE_ATTEMPT_STATUS_ENUM.PENDING,
    BIOMETRIC_SIGNATURE_ATTEMPT_STATUS_ENUM.IN_PROGRESS,
  ];
