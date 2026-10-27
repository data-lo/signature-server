import { NotFoundException } from '@nestjs/common';
import { USER_LIFECYCLE_STATUS_ENUM } from 'src/user/enums/user-lifecycle-status.enum';
import { COLABORATOR_TYPE_ENUM } from '../enum/colaborator-type.enum';
import { COLLABORATOR_STATUS_ENUM } from '../enum/collaborator-status.enum';
import { DOCUMENT_STATUS_ENUM } from '../enum/document-status.enum';
import { SIGNATURE_TYPE_ENUM } from '../enum/signature-type.enum';
import { SIGNING_SESSION_STATUS_ENUM } from '../enum/signing-session-status.enum';
import { GetSigningSessionUseCase } from './get-signing-session.use-case';

const NOW = new Date('2026-10-27T12:00:00.000Z');
const TOKEN = 'a'.repeat(43);

describe('GetSigningSessionUseCase', () => {
  let invitation: Record<string, any> | null;
  let findByToken: jest.Mock;
  let useCase: GetSigningSessionUseCase;

  beforeEach(() => {
    invitation = {
      id: 'inv-1',
      documentId: 'd-1',
      collaboratorId: 'c-1',
      expiresAt: new Date('2026-11-01T00:00:00.000Z'),
      revokedAt: null,
      document: {
        id: 'd-1',
        fileName: 'contrato.pdf',
        status: DOCUMENT_STATUS_ENUM.PENDING_SIGNATURE,
      },
      collaborator: {
        id: 'c-1',
        documentId: 'd-1',
        colaboratorType: COLABORATOR_TYPE_ENUM.SIGNER,
        status: COLLABORATOR_STATUS_ENUM.PENDING,
        accountId: null,
        account: null,
        email: 'ana.lopez@empresa.com',
        signatureType: SIGNATURE_TYPE_ENUM.FIEL,
        simpleSignature: {
          signatureCoordinates: [
            {
              signatureId: 's-1',
              page: 2,
              xRatio: 0.1,
              yRatio: 0.7,
              widthRatio: 0.3,
              heightRatio: 0.1,
              opacity: 1,
            },
            // Coordenadas previas a los ratios: no se pueden ubicar y se descartan.
            { x: 10, y: 20, width: 100, height: 40 },
          ],
        },
      },
    };
    findByToken = jest.fn(async () => invitation);
    useCase = new GetSigningSessionUseCase({ findByToken } as never);
  });

  it('ACTIVE: devuelve la sesión normalizada sólo con lo que resolvió el backend', async () => {
    await expect(useCase.execute(TOKEN, NOW)).resolves.toEqual({
      status: SIGNING_SESSION_STATUS_ENUM.ACTIVE,
      document: { id: 'd-1', name: 'contrato.pdf' },
      signer: {
        collaboratorId: 'c-1',
        maskedEmail: 'a***@empresa.com',
        accountStatus: null,
        guestSigningAllowed: true,
      },
      signature: {
        type: SIGNATURE_TYPE_ENUM.FIEL,
        requiresEmailVerification: true,
        requiresIdentityValidation: false,
      },
      positions: [
        {
          page: 2,
          xRatio: 0.1,
          yRatio: 0.7,
          widthRatio: 0.3,
          heightRatio: 0.1,
        },
      ],
      expiresAt: '2026-11-01T00:00:00.000Z',
    });
    expect(findByToken).toHaveBeenCalledWith(TOKEN);
  });

  it('BIOMETRIC exige validación de identidad', async () => {
    invitation!.collaborator.signatureType = SIGNATURE_TYPE_ENUM.BIOMETRIC;
    const session = await useCase.execute(TOKEN, NOW);
    expect(session.signature).toEqual({
      type: SIGNATURE_TYPE_ENUM.BIOMETRIC,
      requiresEmailVerification: true,
      requiresIdentityValidation: true,
    });
  });

  it('con cuenta PROVISIONED lo informa y no admite firmar sin cuenta', async () => {
    invitation!.collaborator.accountId = 'acc-1';
    invitation!.collaborator.account = {
      user: {
        email: 'ana.lopez@empresa.com',
        lifecycleStatus: USER_LIFECYCLE_STATUS_ENUM.PROVISIONED,
      },
    };
    const session = await useCase.execute(TOKEN, NOW);
    expect(session.signer).toEqual(
      expect.objectContaining({
        accountStatus: USER_LIFECYCLE_STATUS_ENUM.PROVISIONED,
        guestSigningAllowed: false,
      }),
    );
  });

  it.each([
    ['el token no existe', () => (invitation = null)],
    [
      'el colaborador no es firmante',
      () =>
        (invitation!.collaborator.colaboratorType =
          COLABORATOR_TYPE_ENUM.WITNESS),
    ],
    [
      'el firmante no tiene tipo de firma',
      () => (invitation!.collaborator.signatureType = null),
    ],
  ])('404 si %s', async (_case, mutate) => {
    mutate();
    await expect(useCase.execute(TOKEN, NOW)).rejects.toThrow(
      NotFoundException,
    );
  });

  it.each([
    [
      SIGNING_SESSION_STATUS_ENUM.REVOKED,
      () => (invitation!.revokedAt = new Date('2026-10-20T00:00:00.000Z')),
    ],
    [SIGNING_SESSION_STATUS_ENUM.EXPIRED, () => (invitation!.expiresAt = NOW)],
    [
      SIGNING_SESSION_STATUS_ENUM.ALREADY_SIGNED,
      () => (invitation!.collaborator.status = COLLABORATOR_STATUS_ENUM.SIGNED),
    ],
    [
      SIGNING_SESSION_STATUS_ENUM.ALREADY_SIGNED,
      () => (invitation!.document.status = DOCUMENT_STATUS_ENUM.SIGNED),
    ],
    [
      SIGNING_SESSION_STATUS_ENUM.DOCUMENT_CANCELLED,
      () => (invitation!.document.status = DOCUMENT_STATUS_ENUM.CANCELLED),
    ],
    [
      SIGNING_SESSION_STATUS_ENUM.DOCUMENT_CANCELLED,
      () =>
        (invitation!.document.status =
          DOCUMENT_STATUS_ENUM.CANCELLATION_PENDING),
    ],
    [
      SIGNING_SESSION_STATUS_ENUM.UNAVAILABLE,
      () =>
        (invitation!.document.status = DOCUMENT_STATUS_ENUM.PENDING_APPROVAL),
    ],
    [
      SIGNING_SESSION_STATUS_ENUM.UNAVAILABLE,
      () =>
        (invitation!.collaborator.status = COLLABORATOR_STATUS_ENUM.REJECTED),
    ],
  ])(
    '%s: responde sólo el estado, sin datos del documento',
    async (status, mutate) => {
      mutate();
      await expect(useCase.execute(TOKEN, NOW)).resolves.toEqual({ status });
    },
  );

  it('una invitación revocada y vencida se informa como revocada', async () => {
    invitation!.revokedAt = new Date('2026-10-20T00:00:00.000Z');
    invitation!.expiresAt = new Date('2026-10-21T00:00:00.000Z');
    await expect(useCase.execute(TOKEN, NOW)).resolves.toEqual({
      status: SIGNING_SESSION_STATUS_ENUM.REVOKED,
    });
  });
});
