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
  it.each([
    [new OCSPNotAvailableException(), KIND.RETRYABLE, CODE.OCSP_UNAVAILABLE],
    [
      new CertificadoRevocadoException(),
      KIND.TERMINAL,
      CODE.OCSP_CERTIFICATE_REVOKED,
    ],
    [
      new OCSPInvalidResponseException('x'),
      KIND.RECONCILIATION_REQUIRED,
      CODE.OCSP_INVALID_EVIDENCE,
    ],
    [
      new CadenaConfianzaInvalidaException(),
      KIND.RECONCILIATION_REQUIRED,
      CODE.OCSP_INVALID_EVIDENCE,
    ],
    [
      new IncompleteSimpleSignatureDataException('la INE', 'c-1'),
      KIND.RECONCILIATION_REQUIRED,
      CODE.SIMPLE_EVIDENCE_INCOMPLETE,
    ],
    [
      new SealProviderUnavailableException(),
      KIND.RETRYABLE,
      CODE.SEAL_PROVIDER_UNAVAILABLE,
    ],
    [
      new SealProviderTimeoutException(),
      KIND.RETRYABLE,
      CODE.SEAL_PROVIDER_UNAVAILABLE,
    ],
    [
      new SealProviderResponseException(503),
      KIND.RETRYABLE,
      CODE.SEAL_PROVIDER_REJECTED,
    ],
    [
      new SealProviderResponseException(429),
      KIND.RETRYABLE,
      CODE.SEAL_PROVIDER_REJECTED,
    ],
    [
      new SealProviderResponseException(400),
      KIND.RECONCILIATION_REQUIRED,
      CODE.SEAL_PROVIDER_REJECTED,
    ],
    [
      new SealOperationInProgressException(),
      KIND.RETRYABLE,
      CODE.SEAL_IN_PROGRESS,
    ],
    [
      new SealIdempotencyConflictException(),
      KIND.RECONCILIATION_REQUIRED,
      CODE.SEAL_PAYLOAD_CONFLICT,
    ],
    [
      new SealReconciliationRequiredException('PSC_UNCERTAIN_RESULT'),
      KIND.RECONCILIATION_REQUIRED,
      CODE.SEAL_RECONCILIATION_REQUIRED,
    ],
    [
      new SealPersistenceException(),
      KIND.RETRYABLE,
      CODE.SEAL_PERSISTENCE_FAILED,
    ],
    [
      new SealingRequestSnapshotMismatchException(),
      KIND.RECONCILIATION_REQUIRED,
      CODE.SEALING_REQUEST_UNAVAILABLE,
    ],
    [
      new SealedEvidencePdfUpdateException(),
      KIND.RETRYABLE,
      CODE.EVIDENCE_PDF_UPDATE_FAILED,
    ],
    [
      new SignedPdfIntegrityException(),
      KIND.RECONCILIATION_REQUIRED,
      CODE.SIGNED_PDF_INTEGRITY_MISMATCH,
    ],
  ])('%s → %s / %s', (error, kind, code) => {
    expect(classifySealingError(error, PHASE)).toEqual(
      expect.objectContaining({ kind, code, phase: PHASE }),
    );
  });

  it('guarda el estado HTTP de Seal Service', () => {
    expect(
      classifySealingError(new SealProviderResponseException(502), PHASE)
        .upstreamStatus,
    ).toBe(502);
  });

  it('no copia el mensaje de un error desconocido', () => {
    const failure = classifySealingError(
      new Error('respuesta cruda con CURP PEAJ800101HDFRRN09'),
      PHASE,
    );

    expect(failure.kind).toBe(KIND.RETRYABLE);
    expect(failure.code).toBe(CODE.UNEXPECTED_ERROR);
    expect(failure.message).not.toContain('PEAJ');
  });
});
