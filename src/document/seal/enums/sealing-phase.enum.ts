/**
 * Paso que le toca ejecutar a un trabajo de sellado (`document_sealing_jobs.phase`). Avanza en este
 * orden y nunca retrocede:
 *
 * 1. `VERIFYING_OCSP`: sólo firma avanzada. Completa la evidencia de revocación que el SAT no
 *    devolvió al firmar, usando el certificado público persistido (nunca la `.key` ni la
 *    contraseña), y después congela el payload definitivo.
 * 2. `GENERATING_SEAL`: envía el payload congelado a Seal Service y guarda la constancia. La firma
 *    simple empieza aquí, porque su payload se congela al cerrar el documento.
 * 3. `UPDATING_EVIDENCE_PDF`: vuelve a generar la hoja anexa del PDF final con la constancia, que
 *    al cerrar el documento se armó sin ella.
 *
 * Se guarda como `varchar` con un `CHECK` (`CHK_document_sealing_jobs_phase`).
 */
export enum SEALING_PHASE_ENUM {
  VERIFYING_OCSP = 'VERIFYING_OCSP',
  GENERATING_SEAL = 'GENERATING_SEAL',
  UPDATING_EVIDENCE_PDF = 'UPDATING_EVIDENCE_PDF',
}
