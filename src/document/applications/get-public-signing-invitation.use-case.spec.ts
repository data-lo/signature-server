import { NotFoundException } from '@nestjs/common';
import { COLABORATOR_TYPE_ENUM } from '../enum/colaborator-type.enum';
import { COLLABORATOR_STATUS_ENUM } from '../enum/collaborator-status.enum';
import { DOCUMENT_STATUS_ENUM } from '../enum/document-status.enum';
import { SIGNATURE_TYPE_ENUM } from '../enum/signature-type.enum';
import { GetPublicSigningInvitationUseCase } from './get-public-signing-invitation.use-case';

describe('GetPublicSigningInvitationUseCase', () => {
  let document: Record<string, unknown> | null;
  let collaborator: Record<string, unknown> | null;
  let collaboratorFindOne: jest.Mock;
  let useCase: GetPublicSigningInvitationUseCase;

  beforeEach(() => {
    document = {
      id: 'd-1',
      fileName: 'contrato.pdf',
      status: DOCUMENT_STATUS_ENUM.PENDING_SIGNATURE,
    };
    collaborator = {
      id: 'c-1',
      documentId: 'd-1',
      colaboratorType: COLABORATOR_TYPE_ENUM.SIGNER,
      status: COLLABORATOR_STATUS_ENUM.PENDING,
      accountId: null,
      account: null,
      email: 'ana.lopez@empresa.com',
      signatureType: SIGNATURE_TYPE_ENUM.BIOMETRIC,
    };
    collaboratorFindOne = jest.fn(async () => collaborator);
    useCase = new GetPublicSigningInvitationUseCase(
      { findOne: jest.fn(async () => document) } as never,
      { findOne: collaboratorFindOne } as never,
    );
  });

  it('devuelve el nombre del documento, el correo enmascarado y el tipo de firma', async () => {
    await expect(useCase.execute('d-1', 'c-1')).resolves.toEqual({
      documentName: 'contrato.pdf',
      maskedEmail: 'a***@empresa.com',
      signatureType: SIGNATURE_TYPE_ENUM.BIOMETRIC,
      availableForSigning: true,
      guestSigningAllowed: true,
    });
    // Sólo firmantes: testigos y revisores no se firman en esta pantalla.
    expect(collaboratorFindOne).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: 'c-1',
          documentId: 'd-1',
          colaboratorType: COLABORATOR_TYPE_ENUM.SIGNER,
        },
      }),
    );
  });

  it.each([
    ['el documento no existe', () => (document = null)],
    [
      'el colaborador no es firmante del documento',
      () => (collaborator = null),
    ],
  ])('404 si %s', async (_case, mutate) => {
    mutate();
    await expect(useCase.execute('d-1', 'c-1')).rejects.toThrow(
      NotFoundException,
    );
  });

  it.each([
    [
      'el documento ya no está pendiente',
      () => (document!.status = DOCUMENT_STATUS_ENUM.SIGNED),
    ],
    [
      'el firmante ya respondió',
      () => (collaborator!.status = COLLABORATOR_STATUS_ENUM.SIGNED),
    ],
  ])('no disponible si %s', async (_case, mutate) => {
    mutate();
    const result = await useCase.execute('d-1', 'c-1');
    expect(result.availableForSigning).toBe(false);
  });

  it('con cuenta vinculada no admite continuar sin cuenta', async () => {
    collaborator!.accountId = 'acc-1';
    const result = await useCase.execute('d-1', 'c-1');
    expect(result.guestSigningAllowed).toBe(false);
  });

  it.each([SIGNATURE_TYPE_ENUM.SIMPLE, SIGNATURE_TYPE_ENUM.FIEL])(
    'firma %s: todavía no admite continuar sin cuenta',
    async (signatureType) => {
      collaborator!.signatureType = signatureType;
      const result = await useCase.execute('d-1', 'c-1');
      expect(result).toEqual(
        expect.objectContaining({ signatureType, guestSigningAllowed: false }),
      );
    },
  );

  it('si no hay correo de invitación, enmascara el de la cuenta vinculada', async () => {
    Object.assign(collaborator!, {
      email: null,
      accountId: 'acc-1',
      account: { user: { email: 'bruno@empresa.com' } },
    });
    const result = await useCase.execute('d-1', 'c-1');
    expect(result.maskedEmail).toBe('b***@empresa.com');
  });
});
