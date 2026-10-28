import { AuditAction } from 'src/audit/schema/audit-document';

import { SigningInvitationDeliveryService } from './signing-invitation-delivery.service';
import {
  INVITATION_ISSUE_COOLDOWN,
  INVITATION_ISSUE_DAILY,
  SigningRateLimitException,
} from './signing-rate-limit.service';
import { SigningLinkService } from './signing-link.service';

const URL = 'https://app.firmalo.mx/sign/token-nuevo';

describe('SigningInvitationDeliveryService', () => {
  let invitations: { issue: jest.Mock };
  let limits: { consume: jest.Mock };
  let email: { sendDocumentInvitationNotification: jest.Mock };
  let audit: { create: jest.Mock };
  let service: SigningInvitationDeliveryService;

  const input = () => ({
    document: { id: 'd-1', fileName: 'contrato.pdf' } as never,
    collaborator: {
      id: 'c-1',
      email: 'ana@acme.mx',
      firstName: 'Ana',
      lastName: 'López',
      account: null,
    } as never,
    auditActor: {
      type: 'INTEGRATION_API_CLIENT',
      authMechanism: 'API_KEY',
      apiKeyId: 'key-1',
    } as never,
    ipAddress: '10.0.0.1',
  });

  beforeEach(() => {
    invitations = {
      issue: jest.fn(async () => ({
        invitation: { id: 'inv-2', expiresAt: new Date('2026-11-26') },
        token: 'token-nuevo',
        url: URL,
      })),
    };
    limits = { consume: jest.fn().mockResolvedValue(undefined) };
    email = { sendDocumentInvitationNotification: jest.fn() };
    audit = { create: jest.fn() };
    service = new SigningInvitationDeliveryService(
      invitations as never,
      limits as never,
      email as never,
      audit as never,
    );
  });

  it('aplica el límite por firmante, emite, envía el enlace al correo guardado y audita sin el enlace', async () => {
    await expect(service.deliver(input())).resolves.toEqual({
      invitationId: 'inv-2',
      expiresAt: new Date('2026-11-26'),
      emailDelivered: true,
    });
    expect(limits.consume).toHaveBeenCalledWith('collab:c-1', [
      INVITATION_ISSUE_COOLDOWN,
      INVITATION_ISSUE_DAILY,
    ]);
    expect(email.sendDocumentInvitationNotification).toHaveBeenCalledWith(
      'ana@acme.mx',
      expect.any(String),
      'contrato.pdf',
      URL,
    );
    const payload = audit.create.mock.calls[0][0];
    expect(payload).toEqual(
      expect.objectContaining({
        operation: AuditAction.SIGNING_INVITATION_ISSUED,
        actor: expect.objectContaining({
          apiKeyId: 'key-1',
          invitationId: 'inv-2',
          collaboratorId: 'c-1',
        }),
        result: 'SUCCESS',
      }),
    );
    expect(JSON.stringify(payload)).not.toContain('token-nuevo');
  });

  it('con el límite agotado no emite ni envía', async () => {
    limits.consume.mockRejectedValue(new SigningRateLimitException());
    await expect(service.deliver(input())).rejects.toBeInstanceOf(
      SigningRateLimitException,
    );
    expect(invitations.issue).not.toHaveBeenCalled();
  });

  it('un correo que no sale no deshace la invitación: lo informa y lo audita como fallo', async () => {
    email.sendDocumentInvitationNotification.mockRejectedValue(
      new Error('smtp'),
    );
    await expect(service.deliver(input())).resolves.toEqual(
      expect.objectContaining({ emailDelivered: false }),
    );
    expect(audit.create).toHaveBeenCalledWith(
      expect.objectContaining({ result: 'FAILURE' }),
    );
  });
});

describe('SigningLinkService', () => {
  it('documento creado por integración: invitación individual /sign/:token', async () => {
    const issue = jest.fn(async () => ({ url: URL }));
    const links = new SigningLinkService({ issue } as never);

    await expect(
      links.signerLink({
        document: { id: 'd-1', createdViaApiKeyId: 'key-1' },
        collaboratorId: 'c-1',
        email: 'ana@acme.mx',
      }),
    ).resolves.toBe(URL);
    expect(issue).toHaveBeenCalledWith({
      documentId: 'd-1',
      collaboratorId: 'c-1',
    });
  });

  it('cualquier otro documento: el enlace de siempre (/access-document), sin emitir invitación', async () => {
    const issue = jest.fn();
    const links = new SigningLinkService({ issue } as never);

    const url = await links.signerLink({
      document: { id: 'd-1', createdViaApiKeyId: null },
      collaboratorId: 'c-1',
      email: 'ana@acme.mx',
    });

    expect(url).toContain('/access-document?');
    expect(url).toContain('docId=d-1');
    expect(issue).not.toHaveBeenCalled();
  });
});
