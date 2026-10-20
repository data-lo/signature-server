import { NotFoundException } from '@nestjs/common';
import { IsNull } from 'typeorm';
import { CollaboratorEntity } from '../entities/collaborator.entity';
import { GUEST_SIGNING_ACCESS_PURPOSE_ENUM } from '../enum/guest-signing-access-purpose.enum';
import { COLABORATOR_TYPE_ENUM } from '../enum/colaborator-type.enum';
import { COLLABORATOR_STATUS_ENUM } from '../enum/collaborator-status.enum';
import { COLLABORATOR_LINK_OUTCOME_ENUM } from '../enum/collaborator-link-outcome.enum';
import { LinkDocumentCollaboratorUseCase } from './link-document-collaborator.use-case';

/**
 * Vinculación de UNA invitación (`collaboratorId`), la que usa la pantalla pública de firma. Lo que
 * fija: el backend decide con el correo verificado de la cuenta, nunca sustituye una cuenta ya
 * vinculada, y sólo `LINKED`/`ALREADY_LINKED` confirman la vinculación.
 */
describe('LinkDocumentCollaboratorUseCase — por invitación', () => {
  let collaborator: Record<string, unknown> | null;
  let user: Record<string, unknown>;
  let repository: {
    findOne: jest.Mock;
    update: jest.Mock;
    manager: { transaction: jest.Mock };
  };
  let guestAccessRepository: { update: jest.Mock };
  let documentService: {
    findOne: jest.Mock;
    linkPendingCollaboratorAccount: jest.Mock;
  };
  let useCase: LinkDocumentCollaboratorUseCase;

  beforeEach(() => {
    collaborator = {
      id: 'c-1',
      documentId: 'd-1',
      colaboratorType: COLABORATOR_TYPE_ENUM.SIGNER,
      status: COLLABORATOR_STATUS_ENUM.PENDING,
      accountId: null,
      email: 'Ana@Empresa.com',
    };
    user = { id: 'u-1', email: 'ana@empresa.com', isEmailVerified: true };
    repository = {
      findOne: jest.fn(async () => collaborator),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      manager: { transaction: jest.fn() },
    };
    guestAccessRepository = {
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    repository.manager.transaction.mockImplementation(
      (work: (manager: unknown) => unknown) =>
        work({
          getRepository: (entity: unknown) =>
            entity === CollaboratorEntity ? repository : guestAccessRepository,
        }),
    );
    documentService = {
      findOne: jest.fn(async () => ({ id: 'd-1' })),
      linkPendingCollaboratorAccount: jest.fn(async () => ({
        success: true,
        message: '',
        data: { linked: false },
      })),
    };
    useCase = new LinkDocumentCollaboratorUseCase(
      repository as never,
      documentService as never,
      { findOne: jest.fn(async () => user) } as never,
      { findPersonalAccountId: jest.fn(async () => 'acc-mine') } as never,
    );
  });

  it('correo verificado coincidente: vincula con un UPDATE condicionado a sin cuenta y PENDING', async () => {
    const { data } = await useCase.execute('d-1', 'u-1', 'c-1');

    expect(data).toEqual({
      linked: true,
      outcome: COLLABORATOR_LINK_OUTCOME_ENUM.LINKED,
    });
    expect(repository.update).toHaveBeenCalledWith(
      {
        id: 'c-1',
        accountId: IsNull(),
        status: COLLABORATOR_STATUS_ENUM.PENDING,
      },
      { accountId: 'acc-mine' },
    );
  });

  it('al vincular revoca en la misma transacción los accesos de invitado abiertos', async () => {
    await useCase.execute('d-1', 'u-1', 'c-1');

    expect(repository.manager.transaction).toHaveBeenCalledTimes(1);
    expect(guestAccessRepository.update).toHaveBeenCalledWith(
      {
        collaboratorId: 'c-1',
        purpose:
          GUEST_SIGNING_ACCESS_PURPOSE_ENUM.GUEST_ADVANCED_SIGNATURE_ACCESS,
        consumedAt: IsNull(),
        revokedAt: IsNull(),
      },
      { revokedAt: expect.any(Date) },
    );
  });

  it('si el UPDATE no gana, no revoca accesos de invitado', async () => {
    repository.update.mockResolvedValue({ affected: 0 });

    await useCase.execute('d-1', 'u-1', 'c-1');

    expect(guestAccessRepository.update).not.toHaveBeenCalled();
  });

  it('correo distinto: no vincula ni modifica al colaborador', async () => {
    user.email = 'otra@empresa.com';

    const { data } = await useCase.execute('d-1', 'u-1', 'c-1');

    expect(data).toEqual({
      linked: false,
      outcome: COLLABORATOR_LINK_OUTCOME_ENUM.ACCOUNT_MISMATCH,
    });
    expect(repository.update).not.toHaveBeenCalled();
  });

  it('el correo se compara exacto: `_` no actúa como comodín', async () => {
    collaborator!.email = 'anaXb@empresa.com';
    user.email = 'ana_b@empresa.com';

    const { data } = await useCase.execute('d-1', 'u-1', 'c-1');

    expect(data).toEqual(
      expect.objectContaining({
        outcome: COLLABORATOR_LINK_OUTCOME_ENUM.ACCOUNT_MISMATCH,
      }),
    );
  });

  it('correo sin verificar: no vincula', async () => {
    user.isEmailVerified = false;

    const { data } = await useCase.execute('d-1', 'u-1', 'c-1');

    expect(data).toEqual(expect.objectContaining({ linked: false }));
    expect(repository.update).not.toHaveBeenCalled();
  });

  it('ya vinculada a esta cuenta: confirma sin escribir', async () => {
    collaborator!.accountId = 'acc-mine';

    const { data } = await useCase.execute('d-1', 'u-1', 'c-1');

    expect(data).toEqual({
      linked: true,
      outcome: COLLABORATOR_LINK_OUTCOME_ENUM.ALREADY_LINKED,
    });
    expect(repository.update).not.toHaveBeenCalled();
  });

  it('vinculada a otra cuenta: nunca la sustituye, aunque el correo coincida', async () => {
    collaborator!.accountId = 'acc-other';

    const { data } = await useCase.execute('d-1', 'u-1', 'c-1');

    expect(data).toEqual({
      linked: false,
      outcome: COLLABORATOR_LINK_OUTCOME_ENUM.ACCOUNT_MISMATCH,
    });
    expect(repository.update).not.toHaveBeenCalled();
  });

  it('firmante que ya respondió: no se reasigna', async () => {
    collaborator!.status = COLLABORATOR_STATUS_ENUM.SIGNED;

    const { data } = await useCase.execute('d-1', 'u-1', 'c-1');

    expect(data).toEqual({
      linked: false,
      outcome: COLLABORATOR_LINK_OUTCOME_ENUM.NOT_AVAILABLE,
    });
  });

  it('si otra petición ganó la vinculación, decide con lo que quedó', async () => {
    repository.update.mockResolvedValue({ affected: 0 });
    repository.findOne
      .mockResolvedValueOnce(collaborator)
      .mockResolvedValueOnce({ ...collaborator, accountId: 'acc-mine' });

    const { data } = await useCase.execute('d-1', 'u-1', 'c-1');

    expect(data).toEqual(
      expect.objectContaining({
        linked: true,
        outcome: COLLABORATOR_LINK_OUTCOME_ENUM.ALREADY_LINKED,
      }),
    );
  });

  it('404 si el colaborador no es firmante del documento', async () => {
    collaborator = null;

    await expect(useCase.execute('d-1', 'u-1', 'c-1')).rejects.toThrow(
      NotFoundException,
    );
  });

  it('sin collaboratorId conserva el comportamiento anterior', async () => {
    await useCase.execute('d-1', 'u-1');

    expect(documentService.linkPendingCollaboratorAccount).toHaveBeenCalledWith(
      'd-1',
      'u-1',
    );
    expect(repository.findOne).not.toHaveBeenCalled();
  });
});
