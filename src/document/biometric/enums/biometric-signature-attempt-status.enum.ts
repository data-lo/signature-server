/**
 * Estado de un intento de firma biométrica (tabla `biometric_signature_attempts`).
 *
 * Es el estado de la SESIÓN con el proveedor, no el de la firma: mientras la biometría está en
 * curso el colaborador sigue en `PENDING`, y lo único que se mueve es esta fila. La firma se
 * registra —y el colaborador pasa a `SIGNED`— sólo cuando el webhook trae `APPROVED`.
 */
export enum BIOMETRIC_SIGNATURE_ATTEMPT_STATUS_ENUM {
  /** Fila creada; todavía no se recibe la sesión de Didit, o el firmante no la ha abierto. */
  PENDING = 'PENDING',
  /** El firmante abrió la sesión y está haciendo la prueba de vida y el face match. */
  IN_PROGRESS = 'IN_PROGRESS',
  /** Didit dejó el resultado en revisión manual: terminó la prueba, falta el veredicto. */
  IN_REVIEW = 'IN_REVIEW',
  /** Didit aprobó la biometría. Es la única puerta hacia la firma. */
  APPROVED = 'APPROVED',
  /** Didit rechazó la biometría (liveness o face match fallidos). */
  DECLINED = 'DECLINED',
  /** El firmante abandonó la sesión sin terminarla. */
  ABANDONED = 'ABANDONED',
  /** La sesión venció sin resultado. */
  EXPIRED = 'EXPIRED',
  /**
   * No se pudo crear la sesión en Didit, o la biometría se aprobó pero la firma no pudo
   * registrarse (el documento cambió de estado, dejó de ser su turno, etc.). `failure_reason`
   * dice cuál.
   */
  FAILED = 'FAILED',
}

/**
 * Estados en los que un intento sigue abierto: hay, o puede haber, una sesión de Didit en curso.
 *
 * El índice único parcial `UQ_biometric_signature_attempts_active_collaborator` usa exactamente
 * esta lista para impedir dos sesiones simultáneas del mismo colaborador; si cambia aquí, cambia
 * también en la migración.
 */
export const ACTIVE_BIOMETRIC_SIGNATURE_ATTEMPT_STATUSES: readonly BIOMETRIC_SIGNATURE_ATTEMPT_STATUS_ENUM[] =
  [
    BIOMETRIC_SIGNATURE_ATTEMPT_STATUS_ENUM.PENDING,
    BIOMETRIC_SIGNATURE_ATTEMPT_STATUS_ENUM.IN_PROGRESS,
    BIOMETRIC_SIGNATURE_ATTEMPT_STATUS_ENUM.IN_REVIEW,
  ];
