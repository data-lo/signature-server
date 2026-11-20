import type { SEALING_PHASE_ENUM } from '../enums/sealing-phase.enum';

/**
 * Qué hace el worker con un intento fallido de `ProcessDocumentSealingJobUseCase`.
 *
 * - `RETRYABLE`: causa transitoria (SAT o Seal Service caídos, MinIO, una emisión en curso).
 *   Repetir el trabajo desde su fase es seguro: la evidencia ya obtenida está guardada y el envío a
 *   Seal Service es idempotente. Pasa a `RETRY_SCHEDULED`.
 * - `RECONCILIATION_REQUIRED`: repetir a ciegas no cambia el resultado o podría duplicar una
 *   constancia (evidencia incompleta o inválida, OCSP `unknown`, payload distinto, resultado
 *   incierto ante el PSC). Lo resuelve una persona.
 * - `TERMINAL`: el documento no se va a poder sellar nunca, por ejemplo un certificado revocado.
 *   Pasa a `DEAD`.
 */
export enum SEALING_FAILURE_KIND_ENUM {
  RETRYABLE = 'RETRYABLE',
  RECONCILIATION_REQUIRED = 'RECONCILIATION_REQUIRED',
  TERMINAL = 'TERMINAL',
}

/**
 * Código normalizado de un fallo, el que se guarda en `document_sealing_jobs.last_error_code`.
 * Cabe en su `varchar(64)`.
 */
export enum SEALING_FAILURE_CODE_ENUM {
  /** El SAT no respondió la consulta OCSP. */
  OCSP_UNAVAILABLE = 'OCSP_UNAVAILABLE',
  /** El SAT reporta revocado el certificado de un firmante. */
  OCSP_CERTIFICATE_REVOKED = 'OCSP_CERTIFICATE_REVOKED',
  /** La evidencia no sirve: cadena de confianza rota, certificado ilegible o respuesta sin firma. */
  OCSP_INVALID_EVIDENCE = 'OCSP_INVALID_EVIDENCE',
  /** El SAT respondió `unknown`: se conserva, pero no se sella como si fuera `good`. */
  OCSP_STATUS_UNKNOWN = 'OCSP_STATUS_UNKNOWN',
  /** A un firmante FIEL le falta la firma avanzada o su evidencia. */
  ADVANCED_EVIDENCE_INCOMPLETE = 'ADVANCED_EVIDENCE_INCOMPLETE',
  /** A un firmante simple le falta evidencia (rúbrica, INE…). */
  SIMPLE_EVIDENCE_INCOMPLETE = 'SIMPLE_EVIDENCE_INCOMPLETE',
  /** El documento dejó de estar en `SIGNED`. */
  DOCUMENT_NOT_SIGNED = 'DOCUMENT_NOT_SIGNED',
  /** No hay payload congelado o no coincide con su hash. */
  SEALING_REQUEST_UNAVAILABLE = 'SEALING_REQUEST_UNAVAILABLE',
  /** Seal Service no respondió o no se pudo conectar. */
  SEAL_PROVIDER_UNAVAILABLE = 'SEAL_PROVIDER_UNAVAILABLE',
  /** Seal Service respondió un error o una respuesta incompleta. */
  SEAL_PROVIDER_REJECTED = 'SEAL_PROVIDER_REJECTED',
  /** Falta `SEAL_SERVICE_URL` o `SEAL_SERVICE_API_KEY`. */
  SEAL_PROVIDER_CONFIGURATION = 'SEAL_PROVIDER_CONFIGURATION',
  /** Otra petición con la misma clave sigue emitiendo (`202`). */
  SEAL_IN_PROGRESS = 'SEAL_IN_PROGRESS',
  /** La clave ya se usó con otro payload (`409 IDEMPOTENCY_KEY_REUSED`). */
  SEAL_PAYLOAD_CONFLICT = 'SEAL_PAYLOAD_CONFLICT',
  /** Resultado incierto ante el PSC (`409 SEAL_RECONCILIATION_REQUIRED`). */
  SEAL_RECONCILIATION_REQUIRED = 'SEAL_RECONCILIATION_REQUIRED',
  /** La constancia llegó, pero no se pudo guardar en `document_seals`. */
  SEAL_PERSISTENCE_FAILED = 'SEAL_PERSISTENCE_FAILED',
  /** MinIO o la generación de la hoja fallaron al actualizar el PDF final. */
  EVIDENCE_PDF_UPDATE_FAILED = 'EVIDENCE_PDF_UPDATE_FAILED',
  /** El PDF firmado de `signed_documents` ya no tiene el `signedHash` registrado. */
  SIGNED_PDF_INTEGRITY_MISMATCH = 'SIGNED_PDF_INTEGRITY_MISMATCH',
  /** Error no clasificado. */
  UNEXPECTED_ERROR = 'UNEXPECTED_ERROR',
}

/**
 * Fallo de un intento, listo para que el worker lo registre en el trabajo y decida su estado.
 *
 * Nada de esto lleva datos personales, códigos de verificación ni cuerpos del proveedor: termina en
 * `document_sealing_jobs.last_error_message` y en logs.
 */
export interface SealingFailure {
  kind: SEALING_FAILURE_KIND_ENUM;
  code: SEALING_FAILURE_CODE_ENUM;
  /** Diagnóstico sanitizado. */
  message: string;
  /** Fase en la que falló; el siguiente intento la retoma. */
  phase: SEALING_PHASE_ENUM;
  /** Estado HTTP de Seal Service, si llegó a responder (`last_upstream_status`). */
  upstreamStatus: number | null;
}
