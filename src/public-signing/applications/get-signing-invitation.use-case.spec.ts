import { NotFoundException } from '@nestjs/common';
import { COLABORATOR_TYPE_ENUM } from 'src/document/enum/colaborator-type.enum';
import { COLLABORATOR_STATUS_ENUM } from 'src/document/enum/collaborator-status.enum';
import { DOCUMENT_STATUS_ENUM } from 'src/document/enum/document-status.enum';
import { SIGNATURE_TYPE_ENUM } from 'src/document/enum/signature-type.enum';
import { USER_LIFECYCLE_STATUS_ENUM } from 'src/user/enums/user-lifecycle-status.enum';
import { SIGNING_INVITATION_STATUS_ENUM } from '../enums/signing-invitation-status.enum';
import { PublicSigningInvitationResolver } from '../services/public-signing-invitation-resolver.service';
import { GetSigningInvitationUseCase } from './get-signing-invitation.use-case';

const NOW = new Date('2026-10-27T12:00:00.000Z');
const TOKEN = 'a'.repeat(43);

describe('GetSigningInvitationUseCase', () => {
  let invitation: Record<string, any> | null;
  let findByToken: jest.Mock;
  let findSigners: jest.Mock;
  let useCase: GetSigningInvitationUseCase;

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
      },
    };
    findByToken = jest.fn(async () => invitation);
    findSigners = jest.fn(async () => [invitation?.collaborator]);
    useCase = new GetSigningInvitationUseCase(
      new PublicSigningInvitationResolver(
        { findByToken } as never,
        { find: findSigners } as never,
      ),
    );
  });

  it('ACTIVE: contexto mínimo, sin ids del documento ni del colaborador (firmante sin cuenta), posiciones ni PDF', async () => {
    const context = await useCase.execute(TOKEN, NOW);

    expect(context).toEqual({
      status: SIGNING_INVITATION_STATUS_ENUM.ACTIVE,
      document: { name: 'contrato.pdf' },
      signer: {
        maskedEmail: 'a***@empresa.com',
        accountStatus: null,
        publicSigningAllowed: true,
      },
      signature: {
        type: 'ADVANCED',
        requiresEmailVerification: true,
        requiresIdentityValidation: false,
        requiresCertificateValidation: true,
      },
      expiresAt: '2026-11-01T00:00:00.000Z',
    });
    expect(JSON.stringify(context)).not.toMatch(/d-1|c-1|inv-1/);
    expect(findByToken).toHaveBeenCalledWith(TOKEN);
  });

  it('SIMPLE con usuario provisional: firma pública con validación de identidad', async () => {
    invitation!.collaborator.signatureType = SIGNATURE_TYPE_ENUM.SIMPLE;
    invitation!.collaborator.accountId = 'acc-1';
    invitation!.collaborator.account = {
      userId: 'u-1',
      user: {
        email: 'ana.lopez@empresa.com',
        lifecycleStatus: USER_LIFECYCLE_STATUS_ENUM.PROVISIONED,
      },
    };

    const context = await useCase.execute(TOKEN, NOW);

    expect(context.signer).toEqual(
      expect.objectContaining({
        accountStatus: USER_LIFECYCLE_STATUS_ENUM.PROVISIONED,
        publicSigningAllowed: true,
      }),
    );
    expect(context.signature?.requiresIdentityValidation).toBe(true);
  });

  it('SIMPLE con cuenta ACTIVE: no admite la firma pública (firma desde su cuenta)', async () => {
    invitation!.collaborator.signatureType = SIGNATURE_TYPE_ENUM.SIMPLE;
    invitation!.collaborator.accountId = 'acc-1';
    invitation!.collaborator.account = {
      userId: 'u-1',
      user: { lifecycleStatus: USER_LIFECYCLE_STATUS_ENUM.ACTIVE },
    };

    const context = await useCase.execute(TOKEN, NOW);

    expect(context.signer?.publicSigningAllowed).toBe(false);
    expect(context.signature?.requiresIdentityValidation).toBe(false);
    // Para mandarlo a iniciar sesión y, después, al documento en el panel.
    expect(context.document).toEqual({ name: 'contrato.pdf', id: 'd-1' });
  });

  it('FIEL con cuenta PROVISIONED: no expone el documento (esa cuenta no puede iniciar sesión)', async () => {
    invitation!.collaborator.accountId = 'acc-1';
    invitation!.collaborator.account = {
      userId: 'u-1',
      user: { lifecycleStatus: USER_LIFECYCLE_STATUS_ENUM.PROVISIONED },
    };

    const context = await useCase.execute(TOKEN, NOW);

    expect(context.signer?.publicSigningAllowed).toBe(false);
    expect(context.document).toEqual({ name: 'contrato.pdf' });
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
  ])('404 genérico si %s', async (_case, mutate) => {
    mutate();
    await expect(useCase.execute(TOKEN, NOW)).rejects.toThrow(
      new NotFoundException('Esta invitación no es válida.'),
    );
  });

  it.each([
    [
      SIGNING_INVITATION_STATUS_ENUM.REVOKED,
      () => (invitation!.revokedAt = new Date('2026-10-20T00:00:00.000Z')),
    ],
    [
      SIGNING_INVITATION_STATUS_ENUM.EXPIRED,
      () => (invitation!.expiresAt = NOW),
    ],
    [
      SIGNING_INVITATION_STATUS_ENUM.ALREADY_SIGNED,
      () => (invitation!.collaborator.status = COLLABORATOR_STATUS_ENUM.SIGNED),
    ],
    [
      SIGNING_INVITATION_STATUS_ENUM.ALREADY_SIGNED,
      () => (invitation!.document.status = DOCUMENT_STATUS_ENUM.SIGNED),
    ],
    [
      SIGNING_INVITATION_STATUS_ENUM.DOCUMENT_CANCELLED,
      () => (invitation!.document.status = DOCUMENT_STATUS_ENUM.CANCELLED),
    ],
    [
      SIGNING_INVITATION_STATUS_ENUM.DOCUMENT_CANCELLED,
      () =>
        (invitation!.document.status =
          DOCUMENT_STATUS_ENUM.CANCELLATION_PENDING),
    ],
    [
      SIGNING_INVITATION_STATUS_ENUM.UNAVAILABLE,
      () =>
        (invitation!.document.status = DOCUMENT_STATUS_ENUM.PENDING_APPROVAL),
    ],
    [
      SIGNING_INVITATION_STATUS_ENUM.UNAVAILABLE,
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

  it('secuencial: Juan (orden 2) abre su invitación antes de que Ana firme → WAITING_FOR_PREVIOUS_SIGNER, sin datos', async () => {
    invitation!.document.isSequential = true;
    invitation!.collaborator.signingOrder = 2;
    const ana = {
      id: 'c-ana',
      colaboratorType: COLABORATOR_TYPE_ENUM.SIGNER,
      status: COLLABORATOR_STATUS_ENUM.PENDING,
      signingOrder: 1,
    };
    findSigners.mockResolvedValue([ana, invitation!.collaborator]);

    await expect(useCase.execute(TOKEN, NOW)).resolves.toEqual({
      status: SIGNING_INVITATION_STATUS_ENUM.WAITING_FOR_PREVIOUS_SIGNER,
    });

    ana.status = COLLABORATOR_STATUS_ENUM.SIGNED;
    await expect(useCase.execute(TOKEN, NOW)).resolves.toEqual(
      expect.objectContaining({
        status: SIGNING_INVITATION_STATUS_ENUM.ACTIVE,
      }),
    );
  });

  it('una invitación revocada y vencida se informa como revocada', async () => {
    invitation!.revokedAt = new Date('2026-10-20T00:00:00.000Z');
    invitation!.expiresAt = new Date('2026-10-21T00:00:00.000Z');
    await expect(useCase.execute(TOKEN, NOW)).resolves.toEqual({
      status: SIGNING_INVITATION_STATUS_ENUM.REVOKED,
    });
  });
});
