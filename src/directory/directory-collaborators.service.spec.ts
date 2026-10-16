import { BadRequestException } from '@nestjs/common';
import { FindOperator } from 'typeorm';

import { ACCOUNT_TYPE_ENUM } from 'src/account/enums/account-type.enum';

import {
  DIRECTORY_COLLABORATOR_NOT_FOUND_MESSAGE,
  DirectoryCollaboratorsService,
} from './directory-collaborators.service';
import { DirectoryEntity } from './entities/directory.entity';
import { DirectoryContactEntity } from './entities/directory-contact.entity';

/**
 * Lo que se prueba aquí es la COMPOSICIÓN: qué directorio se busca, qué se rechaza y qué se
 * inserta. Que el `JOIN` contacto → cuenta personal → usuario y el `ON CONFLICT` hagan lo correcto
 * en Postgres se comprobó contra la base real (ver la descripción del PR).
 */

const PERSONAL = {
  id: 'acc-personal',
  accountType: ACCOUNT_TYPE_ENUM.PERSONAL,
  organizationId: null,
};
const MEMBER = {
  id: 'acc-member',
  accountType: ACCOUNT_TYPE_ENUM.ORGANIZATION,
  organizationId: 'org-1',
};

/** Query builder encadenable cuyo resultado final se fija por prueba. */
function chain(result: Record<string, unknown> = {}) {
  const builder: Record<string, jest.Mock> = {};
  for (const method of [
    'innerJoin',
    'where',
    'andWhere',
    'select',
    'insert',
    'into',
    'values',
    'orIgnore',
  ]) {
    builder[method] = jest.fn(() => builder);
  }
  builder.getRawMany = jest.fn().mockResolvedValue(result.rawMany ?? []);
  builder.getRawOne = jest.fn().mockResolvedValue(result.rawOne);
  builder.execute = jest.fn().mockResolvedValue({});
  return builder;
}

describe('DirectoryCollaboratorsService.resolveLinkedCollaborators', () => {
  let directoryRepository: { findOne: jest.Mock };
  let contactQuery: ReturnType<typeof chain>;
  let service: DirectoryCollaboratorsService;

  beforeEach(() => {
    directoryRepository = {
      findOne: jest.fn().mockResolvedValue({ id: 'dir-1' }),
    };
    contactQuery = chain({
      rawMany: [
        {
          userId: 'user-ana',
          firstName: 'Ana',
          lastName: 'García',
          email: 'Ana.Garcia@Example.com',
        },
      ],
    });
    const dataSource = {
      getRepository: jest.fn((entity: unknown) =>
        entity === DirectoryEntity
          ? directoryRepository
          : { createQueryBuilder: () => contactQuery },
      ),
    };
    service = new DirectoryCollaboratorsService(dataSource as never);
  });

  it('sin usuarios que resolver no consulta nada', async () => {
    await expect(
      service.resolveLinkedCollaborators(PERSONAL, []),
    ).resolves.toEqual(new Map());
    expect(directoryRepository.findOne).not.toHaveBeenCalled();
  });

  it('resuelve la identidad desde el usuario, con el correo normalizado', async () => {
    const identities = await service.resolveLinkedCollaborators(PERSONAL, [
      'user-ana',
      'user-ana',
    ]);

    expect([...identities]).toEqual([
      [
        'user-ana',
        {
          firstName: 'Ana',
          lastName: 'García',
          email: 'ana.garcia@example.com',
        },
      ],
    ]);
    expect(contactQuery.andWhere).toHaveBeenCalledWith(
      'user.id IN (:...userIds)',
      { userIds: ['user-ana'] },
    );
    expect(contactQuery.where).toHaveBeenCalledWith(
      'contact.directoryId = :directoryId',
      { directoryId: 'dir-1' },
    );
    expect(contactQuery.andWhere).toHaveBeenCalledWith(
      'contact.archivedAt IS NULL',
    );
  });

  it.each([
    ['una cuenta personal', PERSONAL, { personalAccountId: 'acc-personal' }],
    ['una membresía de organización', MEMBER, { organizationId: 'org-1' }],
  ])('busca el directorio de %s', async (_case, account, where) => {
    await service.resolveLinkedCollaborators(account, ['user-ana']);

    expect(directoryRepository.findOne).toHaveBeenCalledWith({ where });
  });

  it('rechaza si la cuenta todavía no tiene directorio', async () => {
    directoryRepository.findOne.mockResolvedValue(null);

    await expect(
      service.resolveLinkedCollaborators(PERSONAL, ['user-ana']),
    ).rejects.toThrow(DIRECTORY_COLLABORATOR_NOT_FOUND_MESSAGE);
  });

  it('rechaza si algún usuario no está vinculado a un contacto vigente del directorio', async () => {
    await expect(
      service.resolveLinkedCollaborators(PERSONAL, ['user-ana', 'user-ajeno']),
    ).rejects.toThrow(BadRequestException);
  });
});

describe('DirectoryCollaboratorsService.addManualCollaboratorsToDirectory', () => {
  let directoryInsert: ReturnType<typeof chain>;
  let contactInserts: ReturnType<typeof chain>[];
  let contactRepository: { createQueryBuilder: jest.Mock; update: jest.Mock };
  let manager: Record<string, jest.Mock>;
  let service: DirectoryCollaboratorsService;

  beforeEach(() => {
    directoryInsert = chain();
    contactInserts = [];
    contactRepository = {
      createQueryBuilder: jest.fn(() => {
        const builder = chain();
        contactInserts.push(builder);
        return builder;
      }),
      update: jest.fn().mockResolvedValue({ affected: 0 }),
    };
    const accountRepository = {
      createQueryBuilder: jest.fn(() =>
        chain({ rawOne: { id: 'acc-personal-ana' } }),
      ),
    };
    manager = {
      createQueryBuilder: jest.fn(() => directoryInsert),
      getRepository: jest.fn((entity: unknown) => {
        if (entity === DirectoryEntity) {
          return {
            findOneOrFail: jest.fn().mockResolvedValue({ id: 'dir-1' }),
          };
        }
        if (entity === DirectoryContactEntity) return contactRepository;
        return accountRepository;
      }),
    };
    service = new DirectoryCollaboratorsService({} as never);
  });

  it('sin colaboradores no crea el directorio ni escribe nada', async () => {
    await service.addManualCollaboratorsToDirectory(
      manager as never,
      PERSONAL,
      [],
    );

    expect(manager.createQueryBuilder).not.toHaveBeenCalled();
    expect(contactRepository.createQueryBuilder).not.toHaveBeenCalled();
  });

  it('crea el directorio si falta y el contacto con ON CONFLICT DO NOTHING, vinculado al usuario', async () => {
    await service.addManualCollaboratorsToDirectory(manager as never, MEMBER, [
      { firstName: 'Ana', lastName: 'García', email: ' Ana@Example.com ' },
    ]);

    expect(directoryInsert.values).toHaveBeenCalledWith({
      organizationId: 'org-1',
      personalAccountId: null,
    });
    expect(directoryInsert.orIgnore).toHaveBeenCalled();
    expect(contactInserts).toHaveLength(1);
    expect(contactInserts[0].values).toHaveBeenCalledWith({
      directoryId: 'dir-1',
      emailNormalized: 'ana@example.com',
      firstName: 'Ana',
      lastName: 'García',
      linkedPersonalAccountId: 'acc-personal-ana',
      createdByAccountId: 'acc-member',
      updatedByAccountId: 'acc-member',
    });
    expect(contactInserts[0].orIgnore).toHaveBeenCalled();
  });

  it('reactiva sólo un contacto ARCHIVADO con ese correo; uno vigente no se toca', async () => {
    await service.addManualCollaboratorsToDirectory(
      manager as never,
      PERSONAL,
      [{ firstName: 'Ana', lastName: 'García', email: 'ana@example.com' }],
    );

    const [criteria, changes] = contactRepository.update.mock.calls[0];
    expect(criteria).toMatchObject({
      directoryId: 'dir-1',
      emailNormalized: 'ana@example.com',
    });
    expect(criteria.archivedAt).toBeInstanceOf(FindOperator);
    expect(changes).toEqual({
      archivedAt: null,
      firstName: 'Ana',
      lastName: 'García',
      updatedByAccountId: 'acc-personal',
    });
  });

  it('un correo repetido en el documento se registra una sola vez', async () => {
    await service.addManualCollaboratorsToDirectory(
      manager as never,
      PERSONAL,
      [
        { firstName: 'Ana', lastName: 'García', email: 'ana@example.com' },
        { firstName: 'Ana', lastName: 'G.', email: 'ANA@example.com' },
      ],
    );

    expect(contactInserts).toHaveLength(1);
  });
});
