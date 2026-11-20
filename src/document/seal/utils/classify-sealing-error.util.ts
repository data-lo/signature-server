import {
  CadenaConfianzaInvalidaException,
  CertificadoInvalidoException,
  CertificadoRevocadoException,
  OCSPInvalidResponseException,
  OCSPNotAvailableException,
} from 'src/efirma/efirma.exceptions';

import { SEALING_PHASE_ENUM } from '../enums/sealing-phase.enum';
import {
  DocumentSealingJobFailedException,
  IncompleteAdvancedSignatureEvidenceException,
  IncompleteSimpleSignatureDataException,
  SealedEvidencePdfUpdateException,
  SealIdempotencyConflictException,
  SealOperationInProgressException,
  SealPersistenceException,
  SealProviderConfigurationException,
  SealProviderResponseException,
  SealProviderTimeoutException,
  SealProviderUnavailableException,
  SealReconciliationRequiredException,
  SealingRequestSnapshotMismatchException,
  SignedPdfIntegrityException,
} from '../exceptions/seal.exceptions';
import {
  SEALING_FAILURE_CODE_ENUM,
  SEALING_FAILURE_KIND_ENUM,
  SealingFailure,
} from '../interfaces/sealing-failure.interface';

/** Estados `4xx` de Seal Service que sí son transitorios. */
const TRANSIENT_CLIENT_STATUSES = new Set([408, 425, 429]);

/**
 * Arma un `SealingFailure`.
 *
 * @param kind - Qué hace el worker con el fallo.
 * @param code - Código normalizado.
 * @param message - Diagnóstico sanitizado.
 * @param phase - Fase en la que falló.
 * @param upstreamStatus - Estado HTTP de Seal Service, si respondió.
 * @returns El fallo.
 *
 * @example
 * ```ts
 * sealingFailure(SEALING_FAILURE_KIND_ENUM.RETRYABLE, SEALING_FAILURE_CODE_ENUM.OCSP_UNAVAILABLE, 'El SAT no respondió.', phase);
 * ```
 */
export function sealingFailure(
  kind: SEALING_FAILURE_KIND_ENUM,
  code: SEALING_FAILURE_CODE_ENUM,
  message: string,
  phase: SEALING_PHASE_ENUM,
  upstreamStatus: number | null = null,
): SealingFailure {
  return { kind, code, message, phase, upstreamStatus };
}

/**
 * Traduce cualquier error de un intento de sellado a un `SealingFailure`, para que el worker
 * decida sin leer mensajes.
 *
 * El mensaje que se guarda es fijo por código, salvo en las excepciones que ya se escriben
 * sanitizadas (evidencia incompleta, que nombra al firmante por el id de su fila, y la fecha de una
 * revocación). Nunca se copia el mensaje de un error desconocido: puede traer un cuerpo del
 * proveedor, una ruta de MinIO o datos de la consulta.
 *
 * `SealingJobLeaseLostException` no pasa por aquí: no es un fallo del trabajo, y quien lo procesa
 * la propaga tal cual.
 *
 * @param error - Lo que lanzó la fase.
 * @param phase - Fase en la que ocurrió.
 * @returns El fallo clasificado.
 *
 * @example
 * ```ts
 * classifySealingError(new OCSPNotAvailableException(), SEALING_PHASE_ENUM.VERIFYING_OCSP);
 * // { kind: 'RETRYABLE', code: 'OCSP_UNAVAILABLE', … }
 * ```
 */
export function classifySealingError(
  error: unknown,
  phase: SEALING_PHASE_ENUM,
): SealingFailure {
  const { RETRYABLE, RECONCILIATION_REQUIRED, TERMINAL } =
    SEALING_FAILURE_KIND_ENUM;
  const CODE = SEALING_FAILURE_CODE_ENUM;

  if (error instanceof DocumentSealingJobFailedException) {
    return error.failure;
  }

  // OCSP
  if (error instanceof OCSPNotAvailableException) {
    return sealingFailure(
      RETRYABLE,
      CODE.OCSP_UNAVAILABLE,
      'El SAT no respondió la consulta OCSP.',
      phase,
    );
  }
  if (error instanceof CertificadoRevocadoException) {
    return sealingFailure(
      TERMINAL,
      CODE.OCSP_CERTIFICATE_REVOKED,
      `El SAT reporta revocado el certificado de un firmante${
        error.revokedDate
          ? ` desde ${new Date(error.revokedDate).toISOString()}`
          : ''
      }.`,
      phase,
    );
  }
  if (error instanceof OCSPInvalidResponseException) {
    return sealingFailure(
      RECONCILIATION_REQUIRED,
      CODE.OCSP_INVALID_EVIDENCE,
      `La respuesta OCSP del SAT no sirve como evidencia (${error.reason}).`,
      phase,
    );
  }
  if (
    error instanceof CadenaConfianzaInvalidaException ||
    error instanceof CertificadoInvalidoException
  ) {
    return sealingFailure(
      RECONCILIATION_REQUIRED,
      CODE.OCSP_INVALID_EVIDENCE,
      'El certificado persistido de un firmante no encadena a una AC del SAT.',
      phase,
    );
  }

  // Evidencia incompleta: sus mensajes ya identifican al firmante sólo por su fila.
  if (error instanceof IncompleteAdvancedSignatureEvidenceException) {
    return sealingFailure(
      RECONCILIATION_REQUIRED,
      CODE.ADVANCED_EVIDENCE_INCOMPLETE,
      error.message,
      phase,
    );
  }
  if (error instanceof IncompleteSimpleSignatureDataException) {
    return sealingFailure(
      RECONCILIATION_REQUIRED,
      CODE.SIMPLE_EVIDENCE_INCOMPLETE,
      error.message,
      phase,
    );
  }

  // Seal Service
  if (
    error instanceof SealProviderUnavailableException ||
    error instanceof SealProviderTimeoutException
  ) {
    // Repetir es seguro: la clave idempotente evita una segunda emisión.
    return sealingFailure(
      RETRYABLE,
      CODE.SEAL_PROVIDER_UNAVAILABLE,
      'Seal Service no respondió.',
      phase,
    );
  }
  if (error instanceof SealProviderResponseException) {
    const status = error.upstreamStatus;
    const permanent =
      status !== null &&
      status >= 400 &&
      status < 500 &&
      !TRANSIENT_CLIENT_STATUSES.has(status);
    return sealingFailure(
      permanent ? RECONCILIATION_REQUIRED : RETRYABLE,
      CODE.SEAL_PROVIDER_REJECTED,
      status
        ? `Seal Service respondió HTTP ${status}.`
        : 'Seal Service devolvió una respuesta incompleta.',
      phase,
      status,
    );
  }
  if (error instanceof SealProviderConfigurationException) {
    return sealingFailure(
      RETRYABLE,
      CODE.SEAL_PROVIDER_CONFIGURATION,
      'Falta la configuración de Seal Service.',
      phase,
    );
  }
  if (error instanceof SealOperationInProgressException) {
    return sealingFailure(
      RETRYABLE,
      CODE.SEAL_IN_PROGRESS,
      'Seal Service sigue emitiendo la constancia.',
      phase,
      202,
    );
  }
  if (error instanceof SealIdempotencyConflictException) {
    return sealingFailure(
      RECONCILIATION_REQUIRED,
      CODE.SEAL_PAYLOAD_CONFLICT,
      'Seal Service ya recibió otro payload con la clave de este documento.',
      phase,
      409,
    );
  }
  if (error instanceof SealReconciliationRequiredException) {
    return sealingFailure(
      RECONCILIATION_REQUIRED,
      CODE.SEAL_RECONCILIATION_REQUIRED,
      `Seal Service requiere conciliar la emisión${
        error.reasonCode ? ` (${error.reasonCode})` : ''
      }.`,
      phase,
      409,
    );
  }
  if (error instanceof SealPersistenceException) {
    // La constancia ya existe en Seal Service: el siguiente intento la recupera sin emitir.
    return sealingFailure(
      RETRYABLE,
      CODE.SEAL_PERSISTENCE_FAILED,
      'No se pudo guardar la constancia recibida.',
      phase,
    );
  }

  // PDF final
  if (error instanceof SealedEvidencePdfUpdateException) {
    return sealingFailure(
      RETRYABLE,
      CODE.EVIDENCE_PDF_UPDATE_FAILED,
      'No se pudo actualizar la hoja de evidencia del PDF final.',
      phase,
    );
  }
  if (error instanceof SealingRequestSnapshotMismatchException) {
    return sealingFailure(
      RECONCILIATION_REQUIRED,
      CODE.SEALING_REQUEST_UNAVAILABLE,
      'El payload congelado no coincide con el registrado en el trabajo.',
      phase,
    );
  }
  if (error instanceof SignedPdfIntegrityException) {
    return sealingFailure(
      RECONCILIATION_REQUIRED,
      CODE.SIGNED_PDF_INTEGRITY_MISMATCH,
      'El PDF firmado almacenado no coincide con su hash registrado.',
      phase,
    );
  }

  return sealingFailure(
    RETRYABLE,
    CODE.UNEXPECTED_ERROR,
    `Error inesperado en la fase ${phase}.`,
    phase,
  );
}
