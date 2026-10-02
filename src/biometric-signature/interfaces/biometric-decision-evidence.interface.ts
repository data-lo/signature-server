/** Una prueba del veredicto de Didit, reducida a lo que sirve como evidencia. */
export interface BiometricCheckEvidence {
  /** Estado que reportó Didit (`Approved`, `Declined`, `In Review`…), tal cual. */
  status: string | null;
  /** Puntaje 0–100 cuando Didit lo informa. */
  score: number | null;
  /** Método de la prueba de vida (p. ej. `ACTIVE_3D`), cuando aplica. */
  method: string | null;
}

/**
 * Lo único que se guarda del veredicto de Didit en `biometric_signature_attempts.decision`.
 *
 * Se descartan a propósito las URLs de imágenes y videos (selfie, retrato, identificación), los
 * datos leídos de la identificación (nombre, CURP, fecha de nacimiento…) y cualquier campo que
 * este contrato no nombre: basta para acreditar QUÉ pruebas se pasaron y con qué resultado, sin
 * conservar biometría en bruto.
 */
export interface BiometricDecisionEvidence {
  /** Estado global de la sesión según Didit. */
  sessionStatus: string | null;
  livenessChecks: BiometricCheckEvidence[];
  faceMatches: BiometricCheckEvidence[];
  idVerifications: BiometricCheckEvidence[];
}
