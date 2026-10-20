import { IsNull, MoreThan } from 'typeorm';
import { GUEST_SIGNING_ACCESS_PURPOSE_ENUM } from '../enum/guest-signing-access-purpose.enum';
import {
  GuestSigningAccessService,
  hashInvitationEmail,
} from './guest-signing-access.service';

const PURPOSE =
  GUEST_SIGNING_ACCESS_PURPOSE_ENUM.GUEST_ADVANCED_SIGNATURE_ACCESS;

describe('GuestSigningAccessService', () => {
  let repository: {
    update: jest.Mock;
    save: jest.Mock;
    create: jest.Mock;
    findOne: jest.Mock;
    manager: { getRepository: jest.Mock };
  };
  let manager: { getRepository: jest.Mock };
  let service: GuestSigningAccessService;

  beforeEach(() => {
    repository = {
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      save: jest.fn(async (row) => ({ id: 'acc-1', ...row })),
      create: jest.fn((row) => row),
      findOne: jest.fn(),
      manager: { getRepository: jest.fn() },
    };
    repository.manager.getRepository.mockReturnValue(repository);
    manager = { getRepository: jest.fn(() => repository) };
    service = new GuestSigningAccessService(repository as never);
  });

  it('hashInvitationEmail normaliza espacios y mayúsculas', () => {
    expect(hashInvitationEmail(' Ana@Correo.MX ')).toBe(
      hashInvitationEmail('ana@correo.mx'),
    );
    expect(hashInvitationEmail('ana@correo.mx')).toMatch(/^[a-f0-9]{64}$/);
  });

  it('emitir revoca antes los accesos abiertos del mismo colaborador y propósito (vencidos incluidos)', async () => {
    const access = await service.issue(manager as never, {
      documentId: 'd-1',
      collaboratorId: 'c-1',
      email: 'Ana@Correo.mx',
      purpose: PURPOSE,
      ipAddress: '10.0.0.1',
      ttlSeconds: 1800,
    });

    expect(repository.update).toHaveBeenCalledWith(
      {
        documentId: 'd-1',
        collaboratorId: 'c-1',
        purpose: PURPOSE,
        consumedAt: IsNull(),
        revokedAt: IsNull(),
      },
      { revokedAt: expect.any(Date) },
    );
    // La revocación va antes que el alta: el índice único parcial no admite dos abiertos.
    expect(repository.update.mock.invocationCallOrder[0]).toBeLessThan(
      repository.save.mock.invocationCallOrder[0],
    );
    expect(access).toEqual(
      expect.objectContaining({
        emailHash: hashInvitationEmail('ana@correo.mx'),
        issuedIpAddress: '10.0.0.1',
        consumedAt: null,
        revokedAt: null,
      }),
    );
    expect(access.expiresAt.getTime() - access.issuedAt.getTime()).toBe(
      1800 * 1000,
    );
    expect(access).not.toHaveProperty('email');
  });

  it('findActive sólo devuelve accesos sin consumir, sin revocar y sin vencer', async () => {
    await service.findActive('acc-1');

    expect(repository.findOne).toHaveBeenCalledWith({
      where: {
        id: 'acc-1',
        consumedAt: IsNull(),
        revokedAt: IsNull(),
        expiresAt: MoreThan(expect.any(Date)),
      },
    });
  });

  it('consume es un UPDATE condicionado: el segundo intento no gana', async () => {
    expect(await service.consume(manager as never, 'acc-1')).toBe(true);

    repository.update.mockResolvedValue({ affected: 0 });
    expect(await service.consume(manager as never, 'acc-1')).toBe(false);

    expect(repository.update).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'acc-1',
        consumedAt: IsNull(),
        revokedAt: IsNull(),
      }),
      { consumedAt: expect.any(Date) },
    );
  });

  it('revoca por colaborador y por documento sólo los abiertos', async () => {
    repository.update.mockResolvedValue({ affected: 2 });

    expect(await service.revokeOpenForCollaborator('c-1', PURPOSE)).toBe(2);
    expect(repository.update).toHaveBeenLastCalledWith(
      {
        collaboratorId: 'c-1',
        purpose: PURPOSE,
        consumedAt: IsNull(),
        revokedAt: IsNull(),
      },
      { revokedAt: expect.any(Date) },
    );

    expect(await service.revokeOpenForDocument('d-1')).toBe(2);
    expect(repository.update).toHaveBeenLastCalledWith(
      { documentId: 'd-1', consumedAt: IsNull(), revokedAt: IsNull() },
      { revokedAt: expect.any(Date) },
    );
  });
});
