import {
  CadenaConfianzaInvalidaException,
  CertificadoRevocadoException,
  OCSPInvalidResponseException,
  OCSPNotAvailableException,
} from 'src/efirma/efirma.exceptions';

import { SEALING_PHASE_ENUM } from '../enums/sealing-phase.enum';
import {
  IncompleteSimpleSignatureDataException,
  SealedEvidencePdfUpdateException,
  SealIdempotencyConflictException,
  SealingRequestSnapshotMismatchException,
  SealOperationInProgressException,
  SealPersistenceException,
  SealProviderConfigurationException,
  SealProviderResponseException,
  SealProviderTimeoutException,
  SealProviderUnavailableException,
  SealReconciliationRequiredException,
  SignedPdfIntegrityException,
} from '../exceptions/seal.exceptions';
import {
  SEALING_FAILURE_CODE_ENUM as CODE,
  SEALING_FAILURE_KIND_ENUM as KIND,
} from '../interfaces/sealing-failure.interface';
import { classifySealingError } from './classify-sealing-error.util';

const PHASE = SEALING_PHASE_ENUM.GENERATING_SEAL;

describe('classifySealingError', () => {
  /** La tabla de la política única de errores del worker. */
  it.each<[string, unknown, KIND, CODE]>([
    [
      'timeout de Seal Service',
      new SealProviderTimeoutException(),
      KIND.RETRYABLE,
      CODE.SEAL_PROVIDER_UNAVAILABLE,
    ],
    [
      'error de red',
      new SealProviderUnavailableException(),
      KIND.RETRYABLE,
      CODE.SEAL_PROVIDER_UNAVAILABLE,
    ],
    [
      'HTTP 429',
      new SealProviderResponseException(429, 30_000),
      KIND.RETRYABLE,
      CODE.SEAL_PROVIDER_REJECTED,
    ],
    [
      'HTTP 503',
      new SealProviderResponseException(503),
      KIND.RETRYABLE,
      CODE.SEAL_PROVIDER_REJECTED,
    ],
    [
      'HTTP 200 incompleto',
      new SealProviderResponseException(null),
      KIND.RETRYABLE,
      CODE.SEAL_PROVIDER_REJECTED,
    ],
    [
      'OCSP no disponible',
      new OCSPNotAvailableException(),
      KIND.RETRYABLE,
      CODE.OCSP_UNAVAILABLE,
    ],
    [
      'respuesta OCSP inválida',
      new OCSPInvalidResponseException('x'),
      KIND.RETRYABLE,
      CODE.OCSP_INVALID_EVIDENCE,
    ],
    [
      'certificado revocado',
      new CertificadoRevocadoException(),
      KIND.TERMINAL,
      CODE.OCSP_CERTIFICATE_REVOKED,
    ],
    [
      'cadena inválida',
      new CadenaConfianzaInvalidaException(),
      KIND.TERMINAL,
      CODE.OCSP_INVALID_EVIDENCE,
    ],
    [
      'HTTP 400',
      new SealProviderResponseException(400),
      KIND.TERMINAL,
      CODE.SEAL_PROVIDER_REJECTED,
    ],
    [
      'HTTP 422',
      new SealProviderResponseException(422),
      KIND.TERMINAL,
      CODE.SEAL_PROVIDER_REJECTED,
    ],
    [
      'evidencia incompleta',
      new IncompleteSimpleSignatureDataException('la INE', 'c-1'),
      KIND.TERMINAL,
      CODE.SIMPLE_EVIDENCE_INCOMPLETE,
    ],
    [
      'HTTP 401',
      new SealProviderResponseException(401),
      KIND.TERMINAL,
      CODE.SEAL_PROVIDER_CONFIGURATION,
    ],
    [
      'HTTP 403',
      new SealProviderResponseException(403),
      KIND.TERMINAL,
      CODE.SEAL_PROVIDER_CONFIGURATION,
    ],
    [
      'configuración faltante',
      new SealProviderConfigurationException(),
      KIND.TERMINAL,
      CODE.SEAL_PROVIDER_CONFIGURATION,
    ],
    [
      'resultado incierto en el PSC',
      new SealReconciliationRequiredException('PSC_UNCERTAIN_RESULT'),
      KIND.RECONCILIATION_REQUIRED,
      CODE.SEAL_RECONCILIATION_REQUIRED,
    ],
    [
      'payload distinto con la misma clave',
      new SealIdempotencyConflictException(),
      KIND.RECONCILIATION_REQUIRED,
      CODE.SEAL_PAYLOAD_CONFLICT,
    ],
    [
      'payload congelado que no corresponde',
      new SealingRequestSnapshotMismatchException(),
      KIND.RECONCILIATION_REQUIRED,
      CODE.SEALING_REQUEST_UNAVAILABLE,
    ],
    [
      'PDF firmado alterado',
      new SignedPdfIntegrityException(),
      KIND.RECONCILIATION_REQUIRED,
      CODE.SIGNED_PDF_INTEGRITY_MISMATCH,
    ],
    [
      'emisión en curso',
      new SealOperationInProgressException(),
      KIND.RETRYABLE,
      CODE.SEAL_IN_PROGRESS,
    ],
    [
      'BD al guardar la constancia',
      new SealPersistenceException(),
      KIND.RETRYABLE,
      CODE.SEAL_PERSISTENCE_FAILED,
    ],
    [
      'MinIO o la hoja',
      new SealedEvidencePdfUpdateException(),
      KIND.RETRYABLE,
      CODE.EVIDENCE_PDF_UPDATE_FAILED,
    ],
  ])('%s → %s', (_, error, kind, code) => {
    expect(classifySealingError(error, PHASE)).toEqual(
      expect.objectContaining({ kind, code, phase: PHASE }),
    );
  });

  it('conserva el estado HTTP original y el Retry-After', () => {
    expect(
      classifySealingError(
        new SealProviderResponseException(429, 30_000),
        PHASE,
      ),
    ).toEqual(
      expect.objectContaining({ upstreamStatus: 429, retryAfterMs: 30_000 }),
    );
  });

  it('un error no clasificado se reintenta con el tope general y sin copiar su mensaje', () => {
    const failure = classifySealingError(
      new Error('respuesta cruda con CURP PEAJ800101HDFRRN09'),
      PHASE,
    );

    expect(failure.kind).toBe(KIND.RETRYABLE);
    expect(failure.code).toBe(CODE.UNEXPECTED_ERROR);
    expect(failure.maxAttempts).toBeNull();
    expect(failure.message).not.toContain('PEAJ');
  });
});
