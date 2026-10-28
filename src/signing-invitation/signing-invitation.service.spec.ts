import { IsNull } from 'typeorm';
import {
  DEFAULT_SIGNING_INVITATION_TTL_DAYS,
  hashSigningInvitationToken,
  isSigningInvitationTokenFormat,
  SigningInvitationService,
} from './signing-invitation.service';

describe('SigningInvitationService', () => {
  let repository: {
    update: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    findOne: jest.Mock;
  };
  let service: SigningInvitationService;

  beforeEach(() => {
    process.env.PUBLIC_WEB_APP_URL = 'https://app.firmalo.mx/';
    repository = {
      update: jest.fn(async () => ({ affected: 1 })),
      create: jest.fn((value) => value),
      save: jest.fn(async (value) => ({ id: 'inv-1', ...value })),
      findOne: jest.fn(async () => null),
    };
    service = new SigningInvitationService(repository as never);
  });

  afterEach(() => {
    delete process.env.PUBLIC_WEB_APP_URL;
  });

  it('emite un token opaco, guarda sólo su hash y revoca antes la invitación abierta', async () => {
    const issued = await service.issue({
      documentId: 'd-1',
      collaboratorId: 'c-1',
    });

    expect(isSigningInvitationTokenFormat(issued.token)).toBe(true);
    expect(issued.token).not.toContain('d-1');
    expect(issued.url).toBe(`https://app.firmalo.mx/sign/${issued.token}`);

    expect(repository.update).toHaveBeenCalledWith(
      { collaboratorId: 'c-1', revokedAt: IsNull() },
      { revokedAt: expect.any(Date) },
    );
    const saved = repository.save.mock.calls[0][0];
    expect(saved.tokenHash).toBe(hashSigningInvitationToken(issued.token));
    expect(JSON.stringify(saved)).not.toContain(issued.token);
    expect(saved.expiresAt.getTime() - saved.issuedAt.getTime()).toBe(
      DEFAULT_SIGNING_INVITATION_TTL_DAYS * 24 * 60 * 60 * 1000,
    );
    // La revocación va antes de guardar la nueva: el índice parcial admite una sola abierta.
    expect(repository.update.mock.invocationCallOrder[0]).toBeLessThan(
      repository.save.mock.invocationCallOrder[0],
    );
  });

  it('dos emisiones nunca dan el mismo token', async () => {
    const first = await service.issue({
      documentId: 'd-1',
      collaboratorId: 'c-1',
    });
    const second = await service.issue({
      documentId: 'd-1',
      collaboratorId: 'c-1',
    });
    expect(first.token).not.toBe(second.token);
  });

  it('busca por hash, con documento, firmante, cuenta y posiciones', async () => {
    const token = 'b'.repeat(43);
    await service.findByToken(token);
    expect(repository.findOne).toHaveBeenCalledWith({
      where: { tokenHash: hashSigningInvitationToken(token) },
      relations: {
        document: true,
        collaborator: { account: { user: true }, simpleSignature: true },
      },
    });
  });

  it.each([
    ['vacío', ''],
    ['un UUID de documento', '6f1c2a90-1b2c-4d3e-8f90-1a2b3c4d5e6f'],
    ['con caracteres fuera de base64url', `${'a'.repeat(42)}/`],
  ])('no consulta la base con un token %s', async (_case, token) => {
    await expect(service.findByToken(token)).resolves.toBeNull();
    expect(repository.findOne).not.toHaveBeenCalled();
  });
});
