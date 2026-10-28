import { IsNull } from 'typeorm';

import {
  hashSigningLaunchToken,
  SIGNING_LAUNCH_TTL_SECONDS,
  SigningLaunchService,
} from './signing-launch.service';
import { SigningInvitationService } from './signing-invitation.service';

describe('SigningLaunchService', () => {
  let repository: {
    create: jest.Mock;
    save: jest.Mock;
    update: jest.Mock;
    findOne: jest.Mock;
  };
  let service: SigningLaunchService;

  beforeEach(() => {
    process.env.PUBLIC_WEB_APP_URL = 'https://app.firmalo.mx';
    repository = {
      create: jest.fn((value) => value),
      save: jest.fn(async (value) => ({ id: 'launch-1', ...value })),
      update: jest.fn(async () => ({ affected: 1 })),
      findOne: jest.fn(async () => ({ id: 'launch-1', invitationId: 'inv-1' })),
    };
    service = new SigningLaunchService(repository as never);
  });

  afterEach(() => {
    delete process.env.PUBLIC_WEB_APP_URL;
  });

  it('emite un token sla_ opaco de cinco minutos, guarda sólo su hash y arma /sign/launch/:token', async () => {
    const issued = await service.issue({
      invitationId: 'inv-1',
      apiKeyId: 'key-1',
      ipAddress: '10.0.0.1',
    });

    expect(issued.token).toMatch(/^sla_[A-Za-z0-9_-]{43}$/);
    expect(issued.url).toBe(
      `https://app.firmalo.mx/sign/launch/${issued.token}`,
    );
    const saved = repository.save.mock.calls[0][0];
    expect(saved.tokenHash).toBe(hashSigningLaunchToken(issued.token));
    expect(JSON.stringify(saved)).not.toContain(issued.token);
    expect(saved.expiresAt.getTime() - saved.issuedAt.getTime()).toBe(
      SIGNING_LAUNCH_TTL_SECONDS * 1000,
    );
    expect(saved).toEqual(
      expect.objectContaining({
        invitationId: 'inv-1',
        issuedViaApiKeyId: 'key-1',
        consumedAt: null,
      }),
    );
  });

  it('el canje es un UPDATE condicionado: sin usar y sin vencer', async () => {
    const token = `sla_${'a'.repeat(43)}`;
    const now = new Date('2026-10-27T12:00:00.000Z');

    await expect(service.redeem(token, now)).resolves.toEqual(
      expect.objectContaining({ invitationId: 'inv-1' }),
    );

    const [where, set] = repository.update.mock.calls[0];
    expect(where.tokenHash).toBe(hashSigningLaunchToken(token));
    expect(where.consumedAt).toEqual(IsNull());
    expect(where.expiresAt).toEqual(
      expect.objectContaining({ _type: 'moreThan', _value: now }),
    );
    expect(set).toEqual({ consumedAt: now });
  });

  it('reutilizado, vencido o inexistente: null (el UPDATE no afecta filas)', async () => {
    repository.update.mockResolvedValue({ affected: 0 });
    await expect(service.redeem(`sla_${'a'.repeat(43)}`)).resolves.toBeNull();
    expect(repository.findOne).not.toHaveBeenCalled();
  });

  it.each(['', 'sla_corto', 'a'.repeat(43), `sla_${'a'.repeat(42)}/`])(
    'no consulta la base con un token sin forma (%p)',
    async (token) => {
      await expect(service.redeem(token)).resolves.toBeNull();
      expect(repository.update).not.toHaveBeenCalled();
    },
  );
});

describe('SigningInvitationService.ensureOpen', () => {
  it('reutiliza la invitación vigente sin emitir otra (no invalida el enlace del correo)', async () => {
    const open = { id: 'inv-open' };
    const repository = {
      findOne: jest.fn(async () => open),
      update: jest.fn(),
      save: jest.fn(),
      create: jest.fn(),
    };
    const service = new SigningInvitationService(repository as never);

    await expect(
      service.ensureOpen({ documentId: 'd-1', collaboratorId: 'c-1' }),
    ).resolves.toBe(open);
    expect(repository.update).not.toHaveBeenCalled();
    expect(repository.save).not.toHaveBeenCalled();
  });

  it('sin una vigente, emite una nueva (sin correo: el servicio no envía nada)', async () => {
    const repository = {
      findOne: jest.fn(async () => null),
      update: jest.fn(async () => ({ affected: 1 })),
      create: jest.fn((value) => value),
      save: jest.fn(async (value) => ({ id: 'inv-new', ...value })),
    };
    const service = new SigningInvitationService(repository as never);

    await expect(
      service.ensureOpen({ documentId: 'd-1', collaboratorId: 'c-1' }),
    ).resolves.toEqual(expect.objectContaining({ id: 'inv-new' }));
  });

  it('la vigencia se configura con SIGNING_INVITATION_TTL_DAYS', async () => {
    process.env.SIGNING_INVITATION_TTL_DAYS = '3';
    const repository = {
      update: jest.fn(async () => ({ affected: 0 })),
      create: jest.fn((value) => value),
      save: jest.fn(async (value) => value),
    };
    const service = new SigningInvitationService(repository as never);

    const { invitation } = await service.issue({
      documentId: 'd-1',
      collaboratorId: 'c-1',
    });
    expect(invitation.expiresAt.getTime() - invitation.issuedAt.getTime()).toBe(
      3 * 24 * 60 * 60 * 1000,
    );
    delete process.env.SIGNING_INVITATION_TTL_DAYS;
  });
});
