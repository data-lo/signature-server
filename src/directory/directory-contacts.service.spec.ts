import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { FindOperator, QueryFailedError } from 'typeorm';

import { AccountEntity } from 'src/account/entities/account.entity';
import { ACCOUNT_TYPE_ENUM } from 'src/account/enums/account-type.enum';
import { UserEntity } from 'src/user/entities/user.entity';

import {
  DirectoryContactsService,
  escapeLikePattern,
  normalizeContactEmail,
} from './directory-contacts.service';
import { DirectoryEntity } from './entities/directory.entity';
import { DirectoryContactEntity } from './entities/directory-contact.entity';

/**
 * El servicio se prueba contra un almacén EN MEMORIA que imita lo que importa de Postgres: la
 * unicidad de un directorio por dueño, la de un correo por directorio y el `LIKE` de la búsqueda.
 * Con repositorios simulados llamada por llamada, el aislamiento entre directorios sería una
 * afirmación sobre qué `where` se mandó; aquí es una afirmación sobre qué datos se devuelven.
 */

type Row = Record<string, unknown>;

/** Igualdad de un `where` de TypeORM con los operadores que usa el servicio (`IsNull`, `Not`). */
function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([key, expected]) => {
    const actual = row[key];
    if (expected instanceof FindOperator) {
      if (expected.type === 'isNull') return actual == null;
      if (expected.type === 'not') return actual !== expected.value;
      throw new Error(`Operador no soportado en la prueba: ${expected.type}`);
    }
    return actual === expected;
  });
}

/** `LIKE` con `\` como escape, traducido a una expresión regular. */
function likeToRegExp(pattern: string): RegExp {
  let source = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const character = pattern[i];
    if (character === '\\') {
      i += 1;
      source += pattern[i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    } else if (character === '%') source += '.*';
    else if (character === '_') source += '.';
    else source += character.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${source}$`);
}

function uniqueViolation(constraint: string): QueryFailedError {
  const error = new QueryFailedError('INSERT', [], new Error('duplicate'));
  (error as unknown as { driverError: Row }).driverError = {
    code: '23505',
    constraint,
  };
  return error;
}

function createStore() {
  const accounts: Partial<AccountEntity>[] = [];
  const users: Partial<UserEntity>[] = [];
  const directories: Partial<DirectoryEntity>[] = [];
  const contacts: Partial<DirectoryContactEntity>[] = [];
  let sequence = 0;
  const nextId = (prefix: string) => `${prefix}-${(sequence += 1)}`;

  const accountRepository = {
    findOne: jest.fn(async ({ where }: { where: Row }) => {
      return (accounts.find((row) => matches(row as Row, where)) ??
        null) as AccountEntity | null;
    }),
  };

  const directoryWhere = (where: Row) =>
    directories.find((row) => matches(row as Row, where)) ?? null;
  const directoryRepository = {
    findOne: jest.fn(async ({ where }: { where: Row }) =>
      directoryWhere(where),
    ),
    findOneOrFail: jest.fn(async ({ where }: { where: Row }) => {
      const directory = directoryWhere(where);
      if (!directory) throw new Error('EntityNotFoundError');
      return directory;
    }),
    createQueryBuilder: jest.fn(() => {
      let values: Row = {};
      const builder = {
        insert: () => builder,
        into: () => builder,
        values: (owner: Row) => {
          values = owner;
          return builder;
        },
        orIgnore: () => builder,
        execute: async () => {
          const taken = directories.some(
            (row) =>
              (values.personalAccountId &&
                row.personalAccountId === values.personalAccountId) ||
              (values.organizationId &&
                row.organizationId === values.organizationId),
          );
          if (!taken) directories.push({ id: nextId('dir'), ...values });
          return {};
        },
      };
      return builder;
    }),
  };

  const contactRepository = {
    findOne: jest.fn(async ({ where }: { where: Row }) => {
      const row = contacts.find((candidate) =>
        matches(candidate as Row, where),
      );
      return row ? ({ ...row } as DirectoryContactEntity) : null;
    }),
    exists: jest.fn(async ({ where }: { where: Row }) =>
      contacts.some((candidate) => matches(candidate as Row, where)),
    ),
    create: jest.fn(
      (data: Row) => ({ ...data }) as unknown as DirectoryContactEntity,
    ),
    save: jest.fn(async (contact: DirectoryContactEntity) => {
      const clash = contacts.some(
        (row) =>
          row.id !== contact.id &&
          row.directoryId === contact.directoryId &&
          row.emailNormalized === contact.emailNormalized,
      );
      if (clash) throw uniqueViolation('UQ_directory_contacts_directory_email');

      const now = new Date('2026-10-07T12:00:00.000Z');
      const saved = {
        ...contact,
        id: contact.id ?? nextId('contact'),
        createdAt: contact.createdAt ?? now,
        updatedAt: now,
      };
      const index = contacts.findIndex((row) => row.id === saved.id);
      if (index === -1) contacts.push(saved);
      else contacts[index] = saved;
      return { ...saved } as DirectoryContactEntity;
    }),
    createQueryBuilder: jest.fn(() => {
      const parameters: Row = {};
      let limit = Infinity;
      const builder = {
        where: (_sql: string, params: Row) => {
          Object.assign(parameters, params);
          return builder;
        },
        andWhere: (_sql: string, params?: Row) => {
          Object.assign(parameters, params ?? {});
          return builder;
        },
        orderBy: () => builder,
        addOrderBy: () => builder,
        take: (value: number) => {
          limit = value;
          return builder;
        },
        getMany: async () => {
          const regExp = likeToRegExp(parameters.pattern as string);
          return contacts
            .filter(
              (row) =>
                row.directoryId === parameters.directoryId &&
                row.archivedAt == null &&
                regExp.test(row.emailNormalized as string),
            )
            .sort(
              (a, b) =>
                (a.lastName as string).localeCompare(b.lastName as string) ||
                (a.firstName as string).localeCompare(b.firstName as string),
            )
            .slice(0, limit);
        },
      };
      return builder;
    }),
  };

  const userRepository = {
    createQueryBuilder: jest.fn(() => {
      let email = '';
      const builder = {
        select: () => builder,
        where: (_sql: string, params: { email: string }) => {
          email = params.email;
          return builder;
        },
        andWhere: () => builder,
        getOne: async () =>
          users.find(
            (user) => user.email!.toLowerCase() === email && !user.isDeleted,
          ) ?? null,
      };
      return builder;
    }),
  };

  return {
    accounts,
    users,
    directories,
    contacts,
    service: new DirectoryContactsService(
      directoryRepository as never,
      contactRepository as never,
      accountRepository as never,
      userRepository as never,
    ),
  };
}

const ALICE = 'user-alice';
const BRUNO = 'user-bruno';
const CARLA = 'user-carla';

const ALICE_PERSONAL = '11111111-1111-4111-8111-111111111111';
const BRUNO_PERSONAL = '22222222-2222-4222-8222-222222222222';
const ALICE_IN_ACME = '33333333-3333-4333-8333-333333333333';
const CARLA_IN_ACME = '44444444-4444-4444-8444-444444444444';
const BRUNO_IN_GLOBEX = '55555555-5555-4555-8555-555555555555';
const ALICE_LEFT_GLOBEX = '66666666-6666-4666-8666-666666666666';
const CARLA_PERSONAL = '77777777-7777-4777-8777-777777777777';

function seed(store: ReturnType<typeof createStore>) {
  store.accounts.push(
    personal(ALICE_PERSONAL, ALICE),
    personal(BRUNO_PERSONAL, BRUNO),
    personal(CARLA_PERSONAL, CARLA),
    membership(ALICE_IN_ACME, ALICE, 'org-acme'),
    membership(CARLA_IN_ACME, CARLA, 'org-acme'),
    membership(BRUNO_IN_GLOBEX, BRUNO, 'org-globex'),
    { ...membership(ALICE_LEFT_GLOBEX, ALICE, 'org-globex'), isActive: false },
  );
  store.users.push(
    { id: CARLA, email: 'Carla@Example.com', isDeleted: false },
    { id: 'user-ghost', email: 'ghost@example.com', isDeleted: true },
  );
}

function personal(id: string, userId: string): Partial<AccountEntity> {
  return {
    id,
    userId,
    accountType: ACCOUNT_TYPE_ENUM.PERSONAL,
    organizationId: null,
    isActive: true,
  };
}

function membership(
  id: string,
  userId: string,
  organizationId: string,
): Partial<AccountEntity> {
  return {
    id,
    userId,
    accountType: ACCOUNT_TYPE_ENUM.ORGANIZATION,
    organizationId,
    isActive: true,
  };
}

const ANA = { firstName: 'Ana', lastName: 'García', email: 'ana@example.com' };

describe('DirectoryContactsService', () => {
  let store: ReturnType<typeof createStore>;
  let service: DirectoryContactsService;

  beforeEach(() => {
    store = createStore();
    seed(store);
    service = store.service;
  });

  describe('cuenta activa', () => {
    it('responde 400 si la petición no declara X-Account-Id', async () => {
      await expect(
        service.getContact(ALICE, undefined, 'contact-1'),
      ).rejects.toThrow(BadRequestException);
    });

    it.each([
      ['de otro usuario', BRUNO_PERSONAL],
      ['inexistente', '99999999-9999-4999-8999-999999999999'],
      ['dada de baja', ALICE_LEFT_GLOBEX],
      ['que no es un UUID', 'no-es-uuid'],
    ])('responde 403 con una cuenta %s', async (_case, accountId) => {
      await expect(
        service.searchContacts(ALICE, accountId, { email: 'a' }),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe('cuenta PERSONAL', () => {
    it('crea el directorio de la cuenta personal y el contacto dentro', async () => {
      const { data } = await service.createContact(ALICE, ALICE_PERSONAL, ANA);

      expect(store.directories).toEqual([
        expect.objectContaining({
          personalAccountId: ALICE_PERSONAL,
          organizationId: null,
        }),
      ]);
      expect(store.contacts[0]).toMatchObject({
        directoryId: store.directories[0].id,
        createdByAccountId: ALICE_PERSONAL,
        updatedByAccountId: ALICE_PERSONAL,
      });
      expect(data).toMatchObject({
        firstName: 'Ana',
        lastName: 'García',
        email: 'ana@example.com',
      });
    });

    it('su directorio personal no es el de la organización en la que también es miembro', async () => {
      await service.createContact(ALICE, ALICE_PERSONAL, ANA);

      const { data } = await service.searchContacts(ALICE, ALICE_IN_ACME, {
        email: 'ana',
      });

      expect(data).toEqual([]);
    });
  });

  describe('cuenta ORGANIZATION', () => {
    it('el directorio es de la organización y lo comparten sus miembros', async () => {
      const { data: created } = await service.createContact(
        ALICE,
        ALICE_IN_ACME,
        ANA,
      );

      expect(store.directories).toEqual([
        expect.objectContaining({ organizationId: 'org-acme' }),
      ]);

      const { data: seenByCarla } = await service.getContact(
        CARLA,
        CARLA_IN_ACME,
        created!.id,
      );
      expect(seenByCarla!.email).toBe('ana@example.com');
    });

    it('registra qué miembro dio de alta y cuál editó', async () => {
      const { data } = await service.createContact(ALICE, ALICE_IN_ACME, ANA);
      await service.updateContact(CARLA, CARLA_IN_ACME, data!.id, {
        lastName: 'García Soto',
      });

      expect(store.contacts[0]).toMatchObject({
        createdByAccountId: ALICE_IN_ACME,
        updatedByAccountId: CARLA_IN_ACME,
        lastName: 'García Soto',
      });
    });
  });

  describe('aislamiento entre directorios', () => {
    let acmeContactId: string;

    beforeEach(async () => {
      acmeContactId = (await service.createContact(ALICE, ALICE_IN_ACME, ANA))
        .data!.id;
    });

    it('otra organización recibe 404 al consultarlo', async () => {
      await expect(
        service.getContact(BRUNO, BRUNO_IN_GLOBEX, acmeContactId),
      ).rejects.toThrow(NotFoundException);
    });

    it('otra cuenta personal recibe 404 al actualizarlo, y el contacto no cambia', async () => {
      await expect(
        service.updateContact(BRUNO, BRUNO_PERSONAL, acmeContactId, {
          firstName: 'Intruso',
        }),
      ).rejects.toThrow(NotFoundException);
      expect(store.contacts[0].firstName).toBe('Ana');
    });

    it('el 404 de un contacto ajeno es idéntico al de uno inexistente', async () => {
      const foreign = await service
        .getContact(BRUNO, BRUNO_PERSONAL, acmeContactId)
        .catch((error: Error) => error);
      const missing = await service
        .getContact(
          ALICE,
          ALICE_IN_ACME,
          '88888888-8888-4888-8888-888888888888',
        )
        .catch((error: Error) => error);

      expect(foreign).toBeInstanceOf(NotFoundException);
      expect((foreign as Error).message).toBe((missing as Error).message);
    });

    it('la búsqueda no devuelve contactos de otros directorios', async () => {
      await service.createContact(BRUNO, BRUNO_IN_GLOBEX, {
        ...ANA,
        email: 'ana.globex@example.com',
      });

      const { data } = await service.searchContacts(BRUNO, BRUNO_IN_GLOBEX, {
        email: 'ana',
      });

      expect(data!.map((contact) => contact.email)).toEqual([
        'ana.globex@example.com',
      ]);
    });

    it('un contacto archivado responde 404 y no aparece en la búsqueda', async () => {
      store.contacts[0].archivedAt = new Date();

      await expect(
        service.getContact(ALICE, ALICE_IN_ACME, acmeContactId),
      ).rejects.toThrow(NotFoundException);
      expect(
        (await service.searchContacts(ALICE, ALICE_IN_ACME, { email: 'ana' }))
          .data,
      ).toEqual([]);
    });
  });

  describe('correo duplicado', () => {
    it('responde 409 con el mismo correo en el mismo directorio, sin distinguir mayúsculas', async () => {
      await service.createContact(ALICE, ALICE_PERSONAL, ANA);

      await expect(
        service.createContact(ALICE, ALICE_PERSONAL, {
          ...ANA,
          email: '  ANA@Example.com ',
        }),
      ).rejects.toThrow(ConflictException);
      expect(store.contacts).toHaveLength(1);
    });

    it('el mismo correo sí se puede dar de alta en otro directorio', async () => {
      await service.createContact(ALICE, ALICE_PERSONAL, ANA);

      await expect(
        service.createContact(BRUNO, BRUNO_PERSONAL, ANA),
      ).resolves.toMatchObject({ success: true });
    });

    it('responde 409 si la base rechaza el correo (dos altas simultáneas)', async () => {
      await service.createContact(ALICE, ALICE_PERSONAL, ANA);
      // La comprobación previa no lo ve: sólo la restricción única de la base.
      jest
        .spyOn(
          (service as unknown as { contactRepository: { findOne: jest.Mock } })
            .contactRepository,
          'findOne',
        )
        .mockResolvedValueOnce(null);

      await expect(
        service.createContact(ALICE, ALICE_PERSONAL, ANA),
      ).rejects.toThrow(ConflictException);
    });

    it('responde 409 al cambiar el correo por uno que ya usa otro contacto', async () => {
      await service.createContact(ALICE, ALICE_PERSONAL, ANA);
      const { data } = await service.createContact(ALICE, ALICE_PERSONAL, {
        ...ANA,
        email: 'otra@example.com',
      });

      await expect(
        service.updateContact(ALICE, ALICE_PERSONAL, data!.id, {
          email: 'ANA@example.com',
        }),
      ).rejects.toThrow(ConflictException);
    });

    it('reactiva un contacto archivado con el mismo correo en vez de duplicarlo', async () => {
      await service.createContact(ALICE, ALICE_PERSONAL, ANA);
      store.contacts[0].archivedAt = new Date();

      const { data } = await service.createContact(ALICE, ALICE_PERSONAL, {
        ...ANA,
        firstName: 'Ana María',
      });

      expect(store.contacts).toHaveLength(1);
      expect(store.contacts[0].archivedAt).toBeNull();
      expect(data!.firstName).toBe('Ana María');
    });
  });

  describe('vínculo con un usuario de la plataforma', () => {
    it('vincula el contacto a la cuenta PERSONAL del usuario con ese correo', async () => {
      const { data } = await service.createContact(ALICE, ALICE_PERSONAL, {
        ...ANA,
        email: 'carla@example.com',
      });

      expect(data!.linkedPersonalAccountId).toBe(CARLA_PERSONAL);
    });

    it('sin usuario con ese correo, el contacto queda sin vínculo', async () => {
      const { data } = await service.createContact(ALICE, ALICE_PERSONAL, ANA);

      expect(data!.linkedPersonalAccountId).toBeNull();
    });

    it('no vincula a un usuario borrado', async () => {
      const { data } = await service.createContact(ALICE, ALICE_PERSONAL, {
        ...ANA,
        email: 'ghost@example.com',
      });

      expect(data!.linkedPersonalAccountId).toBeNull();
    });

    it('al cambiar el correo, vuelve a resolver el vínculo', async () => {
      const { data: created } = await service.createContact(
        ALICE,
        ALICE_PERSONAL,
        { ...ANA, email: 'carla@example.com' },
      );

      const { data: updated } = await service.updateContact(
        ALICE,
        ALICE_PERSONAL,
        created!.id,
        { email: 'carla.externa@example.com' },
      );

      expect(updated!.linkedPersonalAccountId).toBeNull();
    });
  });

  describe('actualización', () => {
    it('cambia sólo lo enviado y no mueve el contacto de directorio', async () => {
      const { data } = await service.createContact(ALICE, ALICE_PERSONAL, ANA);
      const directoryId = store.contacts[0].directoryId;

      const { data: updated } = await service.updateContact(
        ALICE,
        ALICE_PERSONAL,
        data!.id,
        { firstName: 'Ana Sofía' },
      );

      expect(updated).toMatchObject({
        firstName: 'Ana Sofía',
        lastName: 'García',
        email: 'ana@example.com',
      });
      expect(store.contacts[0].directoryId).toBe(directoryId);
    });

    it('normaliza el correo nuevo', async () => {
      const { data } = await service.createContact(ALICE, ALICE_PERSONAL, ANA);

      const { data: updated } = await service.updateContact(
        ALICE,
        ALICE_PERSONAL,
        data!.id,
        { email: ' Ana.Nueva@Example.COM ' },
      );

      expect(updated!.email).toBe('ana.nueva@example.com');
    });
  });

  describe('búsqueda por correo', () => {
    beforeEach(async () => {
      for (const [lastName, email] of [
        ['García', 'ana.garcia@example.com'],
        ['Soto', 'mariana@empresa.mx'],
        ['Ruiz', 'luis_ruiz@example.com'],
        ['Pérez', 'luisxruiz@example.com'],
      ]) {
        await service.createContact(ALICE, ALICE_PERSONAL, {
          firstName: 'Contacto',
          lastName,
          email,
        });
      }
    });

    const search = async (email: string, limit?: number) =>
      (
        await service.searchContacts(ALICE, ALICE_PERSONAL, { email, limit })
      ).data!.map((contact) => contact.email);

    it('acepta coincidencias parciales en cualquier parte del correo', async () => {
      expect(await search('ana')).toEqual([
        'ana.garcia@example.com',
        'mariana@empresa.mx',
      ]);
      expect(await search('empresa')).toEqual(['mariana@empresa.mx']);
    });

    it('no distingue mayúsculas', async () => {
      expect(await search('GARCIA')).toEqual(['ana.garcia@example.com']);
    });

    it('trata `_` y `%` como texto, no como comodines', async () => {
      expect(await search('luis_')).toEqual(['luis_ruiz@example.com']);
      expect(await search('%')).toEqual([]);
    });

    it('respeta el tope de resultados', async () => {
      expect(await search('example', 1)).toHaveLength(1);
    });

    it('sin directorio todavía, responde vacío sin crearlo', async () => {
      const { data } = await service.searchContacts(BRUNO, BRUNO_PERSONAL, {
        email: 'ana',
      });

      expect(data).toEqual([]);
      expect(
        store.directories.some(
          (directory) => directory.personalAccountId === BRUNO_PERSONAL,
        ),
      ).toBe(false);
    });
  });
});

describe('normalizeContactEmail', () => {
  it('recorta y pasa a minúsculas', () => {
    expect(normalizeContactEmail('  Ana@Example.COM ')).toBe('ana@example.com');
  });
});

describe('escapeLikePattern', () => {
  it('escapa %, _ y la barra invertida', () => {
    expect(escapeLikePattern('a%b_c\\d')).toBe('a\\%b\\_c\\\\d');
  });
});
