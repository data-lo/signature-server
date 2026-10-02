import { BadRequestException } from '@nestjs/common';
import { DOCUMENT_STATUS_ENUM } from '../enum/document-status.enum';
import { SIGNATURE_TYPE_ENUM } from '../enum/signature-type.enum';
import { COLLABORATOR_STATUS_ENUM } from '../enum/collaborator-status.enum';
import { COLABORATOR_TYPE_ENUM } from '../enum/colaborator-type.enum';
import { BIOMETRIC_SIGNATURE_ATTEMPT_STATUS_ENUM } from '../biometric/enums/biometric-signature-attempt-status.enum';
import { SignDocumentUseCase } from './sign-document.use-case';

const GEO = { latitude: 19.43, longitude: -99.13 };

/**
 * Rama BIOMETRIC de la firma. Vive aparte de `document.use-cases.spec.ts` porque la firma
 * biométrica sólo entra por el webhook de Didit y lo que hay que fijar aquí es justo eso: sin un
 * intento aprobado para este firmante y este PDF, no hay firma — tampoco por `PATCH /sign`.
 */
describe('SignDocumentUseCase — firma biométrica', () => {
  let signer: Record<string, unknown>;
  let approvedAttempt: Record<string, unknown>;
  let collaboratorRepository: {
    update: jest.Mock;
    save: jest.Mock;
  };
  let biometricAttemptRepository: { findOne: jest.Mock };
  let documentService: Record<string, jest.Mock>;
  let useCase: SignDocumentUseCase;

  beforeEach(() => {
    signer = {
      id: 'col-1',
      colaboratorType: COLABORATOR_TYPE_ENUM.SIGNER,
      status: COLLABORATOR_STATUS_ENUM.PENDING,
      signatureType: SIGNATURE_TYPE_ENUM.BIOMETRIC,
      signingOrder: 1,
      account: { userId: 'user-1', user: { id: 'user-1' } },
    };
    approvedAttempt = {
      id: 'attempt-1',
      collaboratorId: 'col-1',
      userId: 'user-1',
      status: BIOMETRIC_SIGNATURE_ATTEMPT_STATUS_ENUM.APPROVED,
      documentHash: 'hash-original',
    };
    collaboratorRepository = {
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      save: jest.fn().mockResolvedValue(undefined),
    };
    biometricAttemptRepository = {
      findOne: jest.fn().mockResolvedValue(approvedAttempt),
    };
    documentService = {
      findOne: jest.fn().mockResolvedValue({
        id: 'doc-1',
        status: DOCUMENT_STATUS_ENUM.PENDING_SIGNATURE,
        originalHash: 'hash-original',
        isSequential: true,
        requiresVerification: false,
        fileName: 'contrato.pdf',
      }),
      findOrLinkMySignerCollaborator: jest.fn(async () => ({
        signerCollaborators: [signer],
        myParticipant: signer,
      })),
      assertCanSignWithSimpleSignature: jest.fn(),
      snapshotSignatureImage: jest.fn(),
      finalizeSignedDocument: jest.fn().mockResolvedValue(undefined),
      refreshPartiallySignedPreview: jest.fn(),
      notifyNextSigner: jest.fn(),
    };

    useCase = new SignDocumentUseCase(
      { update: jest.fn() } as never,
      collaboratorRepository as never,
      biometricAttemptRepository as never,
      { create: jest.fn() } as never,
      { emitSigned: jest.fn(), emitCollaboratorSigned: jest.fn() } as never,
      { hasConsumedCode: jest.fn().mockResolvedValue(true) } as never,
      documentService as never,
      { assertCanSign: jest.fn() } as never,
    );
  });

  it('por PATCH /sign (sin intento) no firma: la biometría se autoriza en Didit', async () => {
    await expect(
      useCase.execute('doc-1', 'user-1', undefined, GEO),
    ).rejects.toThrow(BadRequestException);

    expect(collaboratorRepository.update).not.toHaveBeenCalled();
    // Y nunca cae en la rama de firma simple.
    expect(
      documentService.assertCanSignWithSimpleSignature,
    ).not.toHaveBeenCalled();
  });

  it('con un intento aprobado firma sin tomar snapshot de rúbrica', async () => {
    const result = await useCase.execute(
      'doc-1',
      'user-1',
      undefined,
      GEO,
      undefined,
      'attempt-1',
    );

    expect(collaboratorRepository.update).toHaveBeenCalledWith(
      { id: 'col-1', status: COLLABORATOR_STATUS_ENUM.PENDING },
      expect.objectContaining({ status: COLLABORATOR_STATUS_ENUM.SIGNED }),
    );
    expect(documentService.snapshotSignatureImage).not.toHaveBeenCalled();
    expect(documentService.finalizeSignedDocument).toHaveBeenCalled();
    expect(result.data).toEqual({ id: 'doc-1', documentCompleted: true });
  });

  it.each([
    [
      'no está aprobado',
      { status: BIOMETRIC_SIGNATURE_ATTEMPT_STATUS_ENUM.DECLINED },
    ],
    ['es de otro colaborador', { collaboratorId: 'col-otro' }],
    ['es de otro usuario', { userId: 'user-otro' }],
    ['se inició sobre otro PDF', { documentHash: 'hash-viejo' }],
  ])('rechaza la firma si el intento %s', async (_, overrides) => {
    Object.assign(approvedAttempt, overrides);

    await expect(
      useCase.execute(
        'doc-1',
        'user-1',
        undefined,
        GEO,
        undefined,
        'attempt-1',
      ),
    ).rejects.toThrow(BadRequestException);

    expect(collaboratorRepository.update).not.toHaveBeenCalled();
  });
});
