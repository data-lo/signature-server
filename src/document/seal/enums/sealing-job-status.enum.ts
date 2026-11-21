/**
 * Estado de ejecución de un trabajo de sellado (`document_sealing_jobs.status`).
 *
 * - `PENDING`: listo para que un worker lo reclame en cuanto llegue `next_attempt_at`.
 * - `PROCESSING`: un worker lo reclamó (`lease_token`) y lo está ejecutando hasta `lease_expires_at`.
 * - `RETRY_SCHEDULED`: el último intento falló por una causa transitoria (SAT o Seal Service
 *   caídos); vuelve a ser elegible en `next_attempt_at`.
 * - `COMPLETED`: la constancia existe y la hoja del PDF ya la muestra. Estado final.
 * - `DEAD`: se agotaron los intentos. Estado final hasta que alguien lo reactive.
 * - `RECONCILIATION_REQUIRED`: el resultado es ambiguo o falta evidencia para sellar, y repetirlo a
 *   ciegas podría duplicar una constancia o enviar datos incompletos. Lo resuelve una persona.
 *
 * Se guarda como `varchar` con un `CHECK` (`CHK_document_sealing_jobs_status`) y no como enum de
 * Postgres: agregar un estado no exige `ALTER TYPE`, que no corre dentro de una transacción.
 */
export enum SEALING_JOB_STATUS_ENUM {
  PENDING = 'PENDING',
  PROCESSING = 'PROCESSING',
  RETRY_SCHEDULED = 'RETRY_SCHEDULED',
  COMPLETED = 'COMPLETED',
  DEAD = 'DEAD',
  RECONCILIATION_REQUIRED = 'RECONCILIATION_REQUIRED',
}

/** Estados en los que un worker puede reclamar el trabajo cuando llega `next_attempt_at`. */
export const CLAIMABLE_SEALING_JOB_STATUSES: readonly SEALING_JOB_STATUS_ENUM[] =
  [SEALING_JOB_STATUS_ENUM.PENDING, SEALING_JOB_STATUS_ENUM.RETRY_SCHEDULED];

/** Estados en los que el documento sigue esperando su constancia. */
export const ACTIVE_SEALING_JOB_STATUSES: readonly SEALING_JOB_STATUS_ENUM[] = [
  SEALING_JOB_STATUS_ENUM.PENDING,
  SEALING_JOB_STATUS_ENUM.PROCESSING,
  SEALING_JOB_STATUS_ENUM.RETRY_SCHEDULED,
];
