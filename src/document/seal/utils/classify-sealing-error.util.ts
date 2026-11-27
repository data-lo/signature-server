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
  VerificationRecordDigestException,
} from '../exceptions/seal.exceptions';
import {
  SEALING_FAILURE_CODE_ENUM,
  SEALING_FAILURE_KIND_ENUM,
  SealingFailure,
} from '../interfaces/sealing-failure.interface';

/**
 * Ejecuciones máximas mientras el SAT responda `unknown`: se reintenta poco, porque un certificado
 * que el respondedor no reconoce rara vez cambia en horas, y nunca se acepta como `good`.
 */
export const OCSP_UNKNOWN_MAX_ATTEMPTS = 3;

/** Estados de Seal Service que se reintentan aunque sean `4xx`. */
const TRANSIENT_CLIENT_STATUSES = new Set([408, 425, 429]);

/** Estados que indican credenciales o configuración del servidor equivocadas. */
const CONFIGURATION_STATUSES = new Set([401, 403, 404]);

/** Datos opcionales de un fallo. */
interface SealingFailureOptions {
  upstreamStatus?: number | null;
  retryAfterMs?: number | null;
  maxAttempts?: number | null;
}

/**
 * Arma un `SealingFailure`.
 *
 * @param kind - Qué hace el worker con el fallo.
 * @param code - Código normalizado.
 * @param message - Diagnóstico sanitizado.
 * @param phase - Fase en la que falló.
 * @param options - Estado HTTP, `Retry-After` y tope propio de ejecuciones, si aplican.
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
  options: SealingFailureOptions = {},
): SealingFailure {
  return {
    kind,
    code,
    message,
    phase,
    upstreamStatus: options.upstreamStatus ?? null,
    retryAfterMs: options.retryAfterMs ?? null,
    maxAttempts: options.maxAttempts ?? null,
  };
}

/**
 * Traduce cualquier error de un intento de sellado a un `SealingFailure`: la política única de
 * errores del worker.
 *
 * | Condición | Clase |
 * | --- | --- |
 * | Timeout o red con Seal Service | `RETRYABLE`; el siguiente intento consulta antes la operación idempotente. |
 * | Seal Service `429` / `5xx` | `RETRYABLE`, con `Retry-After` si vino. |
 * | OCSP no disponible o respuesta inválida | `RETRYABLE`. |
 * | OCSP `unknown` (lo arma el procesador) | `RETRYABLE` con tope `OCSP_UNKNOWN_MAX_ATTEMPTS`. |
 * | Certificado revocado o cadena inválida | `TERMINAL` (`DEAD`). |
 * | Evidencia incompleta, `400`/`422` | `TERMINAL`: el payload requiere corrección. |
 * | Credenciales o configuración (`401`/`403`/`404`, variables faltantes) | `TERMINAL`. |
 * | Resultado incierto, payload distinto, PDF o snapshot que no corresponden | `RECONCILIATION_REQUIRED`. |
 * | BD o MinIO, y errores no clasificados | `RETRYABLE` hasta el tope general. |
 *
 * El mensaje que se guarda es fijo por código, salvo en las excepciones que ya se escriben
 * sanitizadas (evidencia incompleta, que nombra al firmante por el id de su fila, y la fecha de una
 * revocación). Nunca se copia el mensaje de un error desconocido: puede traer un cuerpo del
 * proveedor, una ruta de MinIO o datos de la consulta.
 *
 * `SealingJobLeaseLostException` no pasa por aquí: no es un fallo del trabajo.
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
  if (error instanceof OCSPInvalidResponseException) {
    return sealingFailure(
      RETRYABLE,
      CODE.OCSP_INVALID_EVIDENCE,
      `La respuesta OCSP del SAT no sirve como evidencia (${error.reason}).`,
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
  if (
    error instanceof CadenaConfianzaInvalidaException ||
    error instanceof CertificadoInvalidoException
  ) {
    return sealingFailure(
      TERMINAL,
      CODE.OCSP_INVALID_EVIDENCE,
      'El certificado persistido de un firmante no encadena a una AC del SAT.',
      phase,
    );
  }

  // Evidencia incompleta: sus mensajes ya identifican al firmante sólo por su fila.
  if (error instanceof IncompleteAdvancedSignatureEvidenceException) {
    return sealingFailure(
      TERMINAL,
      CODE.ADVANCED_EVIDENCE_INCOMPLETE,
      error.message,
      phase,
    );
  }
  if (error instanceof IncompleteSimpleSignatureDataException) {
    return sealingFailure(
      TERMINAL,
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
    return sealingFailure(
      RETRYABLE,
      CODE.SEAL_PROVIDER_UNAVAILABLE,
      'Seal Service no respondió; el siguiente intento consulta la operación antes de reenviar.',
      phase,
    );
  }
  if (error instanceof SealProviderResponseException) {
    return classifyProviderResponse(error, phase);
  }
  if (error instanceof SealProviderConfigurationException) {
    return sealingFailure(
      TERMINAL,
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
      { upstreamStatus: 202 },
    );
  }
  if (error instanceof SealIdempotencyConflictException) {
    return sealingFailure(
      RECONCILIATION_REQUIRED,
      CODE.SEAL_PAYLOAD_CONFLICT,
      'Seal Service ya recibió otro payload con la clave de este documento.',
      phase,
      { upstreamStatus: 409 },
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
      { upstreamStatus: 409 },
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

  // PDF final y payload congelado
  if (error instanceof SealedEvidencePdfUpdateException) {
    return sealingFailure(
      RETRYABLE,
      CODE.EVIDENCE_PDF_UPDATE_FAILED,
      'No se pudo actualizar la hoja de evidencia del PDF final.',
      phase,
    );
  }
  if (error instanceof VerificationRecordDigestException) {
    return sealingFailure(
      RETRYABLE,
      CODE.VERIFICATION_RECORD_DIGEST_FAILED,
      'No se pudo registrar el digest del XML de auditoría.',
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

/**
 * Clasifica una respuesta de error de Seal Service por su estado HTTP original.
 *
 * @param error - Excepción con `upstreamStatus` y `retryAfterMs`.
 * @param phase - Fase en la que ocurrió.
 * @returns El fallo clasificado.
 *
 * @example
 * ```ts
 * classifyProviderResponse(new SealProviderResponseException(429, 30_000), phase); // RETRYABLE, 30 s
 * ```
 */
function classifyProviderResponse(
  error: SealProviderResponseException,
  phase: SEALING_PHASE_ENUM,
): SealingFailure {
  const { RETRYABLE, RECONCILIATION_REQUIRED, TERMINAL } =
    SEALING_FAILURE_KIND_ENUM;
  const CODE = SEALING_FAILURE_CODE_ENUM;
  const status = error.upstreamStatus;
  const options = {
    upstreamStatus: status,
    retryAfterMs: error.retryAfterMs,
  };

  if (status === null) {
    return sealingFailure(
      RETRYABLE,
      CODE.SEAL_PROVIDER_REJECTED,
      'Seal Service devolvió una respuesta incompleta.',
      phase,
      options,
    );
  }
  if (status >= 500 || TRANSIENT_CLIENT_STATUSES.has(status)) {
    return sealingFailure(
      RETRYABLE,
      CODE.SEAL_PROVIDER_REJECTED,
      `Seal Service respondió HTTP ${status}.`,
      phase,
      options,
    );
  }
  if (CONFIGURATION_STATUSES.has(status)) {
    return sealingFailure(
      TERMINAL,
      CODE.SEAL_PROVIDER_CONFIGURATION,
      `Seal Service respondió HTTP ${status}: revisar credenciales y URL.`,
      phase,
      options,
    );
  }
  if (status === 409) {
    return sealingFailure(
      RECONCILIATION_REQUIRED,
      CODE.SEAL_RECONCILIATION_REQUIRED,
      'Seal Service respondió un conflicto sin código reconocido.',
      phase,
      options,
    );
  }
  return sealingFailure(
    TERMINAL,
    CODE.SEAL_PROVIDER_REJECTED,
    `Seal Service rechazó el payload (HTTP ${status}); requiere corrección.`,
    phase,
    options,
  );
}
