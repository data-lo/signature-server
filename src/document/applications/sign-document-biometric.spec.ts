import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { DOCUMENT_STATUS_ENUM } from '../enum/document-status.enum';
import { SIGNATURE_TYPE_ENUM } from '../enum/signature-type.enum';
import { COLLABORATOR_STATUS_ENUM } from '../enum/collaborator-status.enum';
import { COLABORATOR_TYPE_ENUM } from '../enum/colaborator-type.enum';
import { VERIFICATION_EVENT_ENUM } from '../enum/verification-event.enum';
import { BIOMETRIC_SIGNATURE_ATTEMPT_STATUS_ENUM } from 'src/biometric-signature/enums/biometric-signature-attempt-status.enum';
import { SignDocumentUseCase } from './sign-document.use-case';

const GEO = { latitude: 19.43, longitude: -99.13 };

/**
 * Firma biométrica en `SignDocumentUseCase`. Vive aparte de `document.use-cases.spec.ts` porque lo
 * que fija es una frontera: la firma biométrica sólo se registra con un intento aprobado por Didit
 * (`executeBiometric`), nunca por `PATCH /sign`, y sirve a firmantes con y sin cuenta.
 */
describe('SignDocumentUseCase — firma biométrica', () => {
  let signer: Record<string, unknown>;
  let attempt: Record<string, unknown>;
  let document: Record<string, unknown>;
  let collaboratorRepository: {
    update: jest.Mock;
    save: jest.Mock;
    find: jest.Mock;
  };
  let documentService: Record<string, jest.Mock>;
  let producer: { emitSigned: jest.Mock; emitCollaboratorSigned: jest.Mock };
  let audit: { create: jest.Mock };
  let hasConsumedCode: jest.Mock;
  let useCase: SignDocumentUseCase;

  beforeEach(() => {
    signer = {
      id: 'c-1',
      colaboratorType: COLABORATOR_TYPE_ENUM.SIGNER,
      status: COLLABORATOR_STATUS_ENUM.PENDING,
      signatureType: SIGNATURE_TYPE_ENUM.BIOMETRIC,
      signingOrder: 1,
      accountId: 'acc-1',
      account: { userId: 'u-1', user: { id: 'u-1' } },
    };
    attempt = {
      id: 'a-1',
      documentId: 'd-1',
      collaboratorId: 'c-1',
      userId: 'u-1',
      status: BIOMETRIC_SIGNATURE_ATTEMPT_STATUS_ENUM.APPROVED,
      documentHash: 'hash-original',
      geolocation: GEO,
      ipAddress: '10.0.0.7',
    };
    document = {
      id: 'd-1',
      status: DOCUMENT_STATUS_ENUM.PENDING_SIGNATURE,
      originalHash: 'hash-original',
      isSequential: true,
      requiresVerification: false,
      fileName: 'contrato.pdf',
    };
    collaboratorRepository = {
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      save: jest.fn().mockResolvedValue(undefined),
      find: jest.fn(async () => [signer]),
    };
    documentService = {
      findOne: jest.fn(async () => document),
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
    producer = { emitSigned: jest.fn(), emitCollaboratorSigned: jest.fn() };
    audit = { create: jest.fn() };
    hasConsumedCode = jest.fn().mockResolvedValue(true);

    useCase = new SignDocumentUseCase(
      { update: jest.fn() } as never,
      collaboratorRepository as never,
      { findOne: jest.fn(async () => attempt) } as never,
      audit as never,
      producer as never,
      { hasConsumedCode } as never,
      documentService as never,
      { assertCanSign: jest.fn() } as never,
    );
  });

  it('por PATCH /sign un firmante biométrico nunca firma (ni cae en la rama simple)', async () => {
    await expect(useCase.execute('d-1', 'u-1', undefined, GEO)).rejects.toThrow(
      BadRequestException,
    );

    expect(collaboratorRepository.update).not.toHaveBeenCalled();
    expect(
      documentService.assertCanSignWithSimpleSignature,
    ).not.toHaveBeenCalled();
  });

  it('con cuenta: firma con la ubicación e IP del intento, sin snapshot de rúbrica', async () => {
    const result = await useCase.executeBiometric('a-1');

    expect(collaboratorRepository.update).toHaveBeenCalledWith(
      { id: 'c-1', status: COLLABORATOR_STATUS_ENUM.PENDING },
      expect.objectContaining({ status: COLLABORATOR_STATUS_ENUM.SIGNED }),
    );
    expect(collaboratorRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({ geolocation: GEO, ipAddress: '10.0.0.7' }),
    );
    expect(documentService.snapshotSignatureImage).not.toHaveBeenCalled();
    expect(producer.emitCollaboratorSigned).toHaveBeenCalledWith(
      expect.objectContaining({ actorUserId: 'u-1', collaboratorId: 'c-1' }),
    );
    expect(result.data).toEqual({ id: 'd-1', documentCompleted: true });
  });

  it('invitado sin cuenta: firma por colaborador, con un actor que no es un usuario', async () => {
    attempt.userId = null;
    Object.assign(signer, { accountId: null, account: null });

    await useCase.executeBiometric('a-1');

    expect(collaboratorRepository.update).toHaveBeenCalledWith(
      { id: 'c-1', status: COLLABORATOR_STATUS_ENUM.PENDING },
      expect.anything(),
    );
    expect(producer.emitSigned).toHaveBeenCalledWith(
      expect.objectContaining({ actorUserId: 'guest-collaborator:c-1' }),
    );
    expect(audit.create).toHaveBeenCalledWith(
      expect.objectContaining({ ipAddress: '10.0.0.7' }),
    );
  });

  it('invitado: si el documento exige código, cuenta el de acceso de invitado', async () => {
    attempt.userId = null;
    Object.assign(signer, { accountId: null, account: null });
    document.requiresVerification = true;

    await useCase.executeBiometric('a-1');

    expect(hasConsumedCode).toHaveBeenCalledWith(
      'd-1',
      'c-1',
      VERIFICATION_EVENT_ENUM.GUEST_BIOMETRIC_ACCESS,
    );
  });

  it.each([
    [
      'el intento no está aprobado',
      () => (attempt.status = BIOMETRIC_SIGNATURE_ATTEMPT_STATUS_ENUM.DECLINED),
      BadRequestException,
    ],
    [
      'el PDF cambió desde que se inició',
      () => (document.originalHash = 'hash-nuevo'),
      BadRequestException,
    ],
    [
      'el documento ya no está pendiente',
      () => (document.status = DOCUMENT_STATUS_ENUM.CANCELLED),
      BadRequestException,
    ],
    [
      'el colaborador ahora es de otro usuario',
      () => Object.assign(signer, { account: { userId: 'u-otro' } }),
      BadRequestException,
    ],
    [
      'el invitado vinculó una cuenta entre medias',
      () => {
        attempt.userId = null;
      },
      BadRequestException,
    ],
    [
      'ya respondió',
      () => (signer.status = COLLABORATOR_STATUS_ENUM.REJECTED),
      BadRequestException,
    ],
    [
      'ya no es su turno',
      () =>
        collaboratorRepository.find.mockResolvedValue([
          { ...signer, id: 'c-0', signingOrder: 0 },
          signer,
        ]),
      ForbiddenException,
    ],
  ])('no firma si %s', async (_, arrange, expected) => {
    arrange();

    await expect(useCase.executeBiometric('a-1')).rejects.toThrow(expected);
    expect(collaboratorRepository.update).not.toHaveBeenCalled();
  });

  it('dos entregas a la vez: el claim atómico deja firmar sólo una', async () => {
    collaboratorRepository.update.mockResolvedValue({ affected: 0 });

    await expect(useCase.executeBiometric('a-1')).rejects.toThrow(
      'Ya respondiste a esta solicitud de firma',
    );
    expect(documentService.finalizeSignedDocument).not.toHaveBeenCalled();
  });
});
