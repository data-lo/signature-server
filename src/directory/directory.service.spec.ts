import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { IsNull, QueryFailedError } from 'typeorm';

import { AuthorizationContext } from 'src/authorization/interfaces/authorization-context.interface';
import { ACTION_KEY_ENUM } from 'src/roles/enums/action-key.enum';
import { PERMISSION_SCOPE_ENUM } from 'src/roles/enums/permission-scope.enum';
import { RESOURCE_KEY_ENUM } from 'src/roles/enums/resource-key.enum';

import {
  DirectoryService,
  escapeLikePattern,
  normalizeContactEmail,
} from './directory.service';
import { DirectoryEntity } from './entities/directory.entity';
import { DirectoryContactEntity } from './entities/directory-contact.entity';

/** Contexto que deja `PermissionsGuard` para una cuenta personal. */
function personalAuthorization(
  overrides: Partial<AuthorizationContext> = {},
): AuthorizationContext {
  return {
    userId: 'user-1',
    organizationId: null,
    accountId: 'account-personal',
    roleId: null,
    resource: RESOURCE_KEY_ENUM.DIRECTORY,
    action: ACTION_KEY_ENUM.READ,
    scopes: [PERMISSION_SCOPE_ENUM.ANY],
    ...overrides,
  };
}

/** Contexto de un miembro de organización: su membresía y la organización. */
function organizationAuthorization(
  accountId: string,
  organizationId = 'org-1',
): AuthorizationContext {
  return personalAuthorization({
    userId: `user-${accountId}`,
    accountId,
    organizationId,
    roleId: 'role-admin',
  });
}

function contact(
  overrides: Partial<DirectoryContactEntity> = {},
): DirectoryContactEntity {
  return {
    id: 'contact-1',
    directoryId: 'directory-1',
    emailNormalized: 'ana@example.com',
    firstName: 'Ana',
    lastName: 'García',
    taxId: null,
    phone: null,
    linkedPersonalAccountId: null,
    createdByAccountId: 'account-personal',
    updatedByAccountId: 'account-personal',
    archivedAt: null,
    createdAt: new Date('2026-10-06T10:00:00Z'),
    updatedAt: new Date('2026-10-06T10:00:00Z'),
    ...overrides,
  } as DirectoryContactEntity;
}

function uniqueViolation(constraint: string): QueryFailedError {
  const error = new QueryFailedError('INSERT', [], new Error('duplicate'));
  Object.assign(error, { driverError: { code: '23505', constraint } });
  return error;
}

describe('DirectoryService', () => {
  let service: DirectoryService;
  let directoryRepository: Record<string, jest.Mock>;
  let contactRepository: Record<string, jest.Mock>;
  let insertBuilder: Record<string, jest.Mock>;
  let listBuilder: Record<string, jest.Mock>;

  const DIRECTORY = { id: 'directory-1' } as DirectoryEntity;

  beforeEach(async () => {
    insertBuilder = {
      insert: jest.fn().mockReturnThis(),
      into: jest.fn().mockReturnThis(),
      values: jest.fn().mockReturnThis(),
      orIgnore: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue({}),
    };
    listBuilder = {
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      addOrderBy: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      getManyAndCount: jest.fn().mockResolvedValue([[contact()], 1]),
    };
    directoryRepository = {
      findOne: jest.fn().mockResolvedValue(DIRECTORY),
      findOneOrFail: jest.fn().mockResolvedValue(DIRECTORY),
      createQueryBuilder: jest.fn(() => insertBuilder),
    };
    contactRepository = {
      findOne: jest.fn().mockResolvedValue(null),
      exists: jest.fn().mockResolvedValue(false),
      create: jest.fn((data) => ({ ...data })),
      merge: jest.fn((entity, data) => Object.assign(entity, data)),
      save: jest.fn(async (entity) => ({
        id: 'contact-new',
        createdAt: new Date(),
        updatedAt: new Date(),
        ...entity,
      })),
      createQueryBuilder: jest.fn(() => listBuilder),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        DirectoryService,
        {
          provide: getRepositoryToken(DirectoryEntity),
          useValue: directoryRepository,
        },
        {
          provide: getRepositoryToken(DirectoryContactEntity),
          useValue: contactRepository,
        },
      ],
    }).compile();

    service = moduleRef.get(DirectoryService);
  });

  describe('cuenta activa', () => {
    it('sin X-Account-Id responde 400 y no consulta nada', async () => {
      await expect(
        service.listContacts(personalAuthorization(), undefined, {}),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(directoryRepository.findOne).not.toHaveBeenCalled();
    });

    /**
     * El guard prioriza `X-Organization-Id`: si autorizó otra membresía que la del header, el
     * directorio no puede salir de ninguna de las dos.
     */
    it('con X-Account-Id distinto de la cuenta autorizada responde 403', async () => {
      await expect(
        service.createContact(personalAuthorization(), 'account-otra', {
          firstName: 'Ana',
          lastName: 'García',
          email: 'ana@example.com',
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(insertBuilder.execute).not.toHaveBeenCalled();
    });
  });

  describe('aislamiento', () => {
    it('una cuenta personal usa el directorio de su propia cuenta', async () => {
      await service.listContacts(
        personalAuthorization(),
        'account-personal',
        {},
      );

      expect(directoryRepository.findOne).toHaveBeenCalledWith({
        where: { personalAccountId: 'account-personal' },
      });
    });

    it('dos miembros de la misma organización resuelven el mismo directorio', async () => {
      await service.listContacts(
        organizationAuthorization('account-a'),
        'account-a',
        {},
      );
      await service.listContacts(
        organizationAuthorization('account-b'),
        'account-b',
        {},
      );

      expect(directoryRepository.findOne).toHaveBeenNthCalledWith(1, {
        where: { organizationId: 'org-1' },
      });
      expect(directoryRepository.findOne).toHaveBeenNthCalledWith(2, {
        where: { organizationId: 'org-1' },
      });
    });

    it('el contacto se busca acotado al directorio activo y vigente', async () => {
      contactRepository.findOne.mockResolvedValue(contact());

      await service.updateContact(
        personalAuthorization(),
        'account-personal',
        'contact-1',
        { phone: '+52 1' },
      );

      expect(contactRepository.findOne).toHaveBeenCalledWith({
        where: {
          id: 'contact-1',
          directoryId: 'directory-1',
          archivedAt: IsNull(),
        },
      });
    });

    it('el contacto de otro directorio responde 404 al editar y al archivar', async () => {
      contactRepository.findOne.mockResolvedValue(null);

      await expect(
        service.updateContact(
          organizationAuthorization('account-b', 'org-2'),
          'account-b',
          'contact-1',
          { firstName: 'Intruso' },
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
      await expect(
        service.archiveContact(
          organizationAuthorization('account-b', 'org-2'),
          'account-b',
          'contact-1',
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(contactRepository.save).not.toHaveBeenCalled();
    });

    it('sin directorio, editar responde 404 sin crearlo', async () => {
      directoryRepository.findOne.mockResolvedValue(null);

      await expect(
        service.updateContact(
          personalAuthorization(),
          'account-personal',
          'contact-1',
          {},
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(insertBuilder.execute).not.toHaveBeenCalled();
    });
  });

  describe('listContacts', () => {
    it('sin directorio responde la página vacía sin crearlo', async () => {
      directoryRepository.findOne.mockResolvedValue(null);

      const result = await service.listContacts(
        personalAuthorization(),
        'account-personal',
        { page: 2, limit: 10 },
      );

      expect(result).toEqual({
        items: [],
        pagination: { page: 2, limit: 10, total: 0, totalPages: 0 },
      });
      expect(insertBuilder.execute).not.toHaveBeenCalled();
    });

    it('excluye archivados, pagina y publica el correo normalizado', async () => {
      listBuilder.getManyAndCount.mockResolvedValue([[contact()], 26]);

      const result = await service.listContacts(
        personalAuthorization(),
        'account-personal',
        { page: 2, limit: 25 },
      );

      expect(listBuilder.where).toHaveBeenCalledWith(
        'contact.directoryId = :directoryId',
        { directoryId: 'directory-1' },
      );
      expect(listBuilder.andWhere).toHaveBeenCalledWith(
        'contact.archivedAt IS NULL',
      );
      expect(listBuilder.skip).toHaveBeenCalledWith(25);
      expect(listBuilder.take).toHaveBeenCalledWith(25);
      expect(result.pagination).toEqual({
        page: 2,
        limit: 25,
        total: 26,
        totalPages: 2,
      });
      expect(result.items[0].email).toBe('ana@example.com');
    });

    it('busca por nombre, apellido, nombre completo, correo y RFC, con los comodines escapados', async () => {
      await service.listContacts(personalAuthorization(), 'account-personal', {
        search: '50%_x',
      });

      const [clause, params] = listBuilder.andWhere.mock.calls[1];
      expect(clause).toContain('contact.firstName ILIKE :search');
      expect(clause).toContain('contact.lastName ILIKE :search');
      expect(clause).toContain('CONCAT(contact.firstName');
      expect(clause).toContain('contact.emailNormalized ILIKE :search');
      expect(clause).toContain('contact.taxId ILIKE :search');
      expect(params).toEqual({ search: '%50\\%\\_x%' });
    });
  });

  describe('createContact', () => {
    const dto = {
      firstName: 'Ana',
      lastName: 'García',
      email: '  Ana@Example.COM ',
      taxId: 'gaaa900101xxx',
      phone: '+526141234567',
    };

    it('crea el directorio sin carreras (ON CONFLICT DO NOTHING) y luego lo lee', async () => {
      await service.createContact(
        organizationAuthorization('account-a'),
        'account-a',
        dto,
      );

      expect(insertBuilder.values).toHaveBeenCalledWith({
        personalAccountId: null,
        organizationId: 'org-1',
      });
      expect(insertBuilder.orIgnore).toHaveBeenCalled();
      expect(directoryRepository.findOneOrFail).toHaveBeenCalledWith({
        where: { organizationId: 'org-1' },
      });
    });

    it('normaliza correo y RFC, y toma la autoría de la membresía autorizada', async () => {
      const result = await service.createContact(
        organizationAuthorization('account-a'),
        'account-a',
        dto,
      );

      expect(contactRepository.create).toHaveBeenCalledWith({
        firstName: 'Ana',
        lastName: 'García',
        taxId: 'GAAA900101XXX',
        phone: '+526141234567',
        directoryId: 'directory-1',
        emailNormalized: 'ana@example.com',
        createdByAccountId: 'account-a',
        updatedByAccountId: 'account-a',
      });
      expect(result.email).toBe('ana@example.com');
    });

    /** El `ValidationPipe` global ya los descarta; esto comprueba que el servicio tampoco los lee. */
    it('ignora directoryId y autoría aunque lleguen en el cuerpo', async () => {
      await service.createContact(personalAuthorization(), 'account-personal', {
        ...dto,
        directoryId: 'directory-ajeno',
        createdByAccountId: 'account-ajena',
      } as never);

      expect(contactRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          directoryId: 'directory-1',
          createdByAccountId: 'account-personal',
          updatedByAccountId: 'account-personal',
        }),
      );
    });

    it('con un contacto vigente con el mismo correo responde 409', async () => {
      contactRepository.findOne.mockResolvedValue(contact());

      await expect(
        service.createContact(personalAuthorization(), 'account-personal', dto),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(contactRepository.findOne).toHaveBeenCalledWith({
        where: {
          directoryId: 'directory-1',
          emailNormalized: 'ana@example.com',
        },
      });
      expect(contactRepository.save).not.toHaveBeenCalled();
    });

    it('con un contacto archivado con el mismo correo lo reactiva con los datos nuevos', async () => {
      const archived = contact({
        archivedAt: new Date('2026-10-01'),
        firstName: 'Viejo',
        createdByAccountId: 'account-original',
      });
      contactRepository.findOne.mockResolvedValue(archived);

      const result = await service.createContact(
        personalAuthorization(),
        'account-personal',
        dto,
      );

      expect(contactRepository.create).not.toHaveBeenCalled();
      expect(result.archivedAt).toBeNull();
      expect(result.firstName).toBe('Ana');
      expect(contactRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'contact-1',
          createdByAccountId: 'account-original',
          updatedByAccountId: 'account-personal',
        }),
      );
    });

    it('la carrera de dos altas del mismo correo termina en 409', async () => {
      contactRepository.save.mockRejectedValue(
        uniqueViolation('UQ_directory_contacts_directory_email'),
      );

      await expect(
        service.createContact(personalAuthorization(), 'account-personal', dto),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('cualquier otro error de la base no se disfraza de 409', async () => {
      const error = uniqueViolation('PK_directory_contacts');
      contactRepository.save.mockRejectedValue(error);

      await expect(
        service.createContact(personalAuthorization(), 'account-personal', dto),
      ).rejects.toBe(error);
    });
  });

  describe('updateContact', () => {
    beforeEach(() => {
      contactRepository.findOne.mockResolvedValue(contact());
    });

    it('cambia sólo lo enviado y registra quién lo cambió', async () => {
      const result = await service.updateContact(
        organizationAuthorization('account-b'),
        'account-b',
        'contact-1',
        { lastName: 'García López', taxId: null },
      );

      expect(result).toEqual(
        expect.objectContaining({
          firstName: 'Ana',
          lastName: 'García López',
          taxId: null,
          email: 'ana@example.com',
        }),
      );
      expect(contactRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({ updatedByAccountId: 'account-b' }),
      );
    });

    it('normaliza el correo nuevo y comprueba que esté libre en el directorio', async () => {
      const result = await service.updateContact(
        personalAuthorization(),
        'account-personal',
        'contact-1',
        { email: ' Ana.Garcia@Example.com ' },
      );

      expect(contactRepository.exists).toHaveBeenCalledWith({
        where: {
          directoryId: 'directory-1',
          emailNormalized: 'ana.garcia@example.com',
        },
      });
      expect(result.email).toBe('ana.garcia@example.com');
    });

    it('con el correo nuevo en uso responde 409', async () => {
      contactRepository.exists.mockResolvedValue(true);

      await expect(
        service.updateContact(
          personalAuthorization(),
          'account-personal',
          'contact-1',
          { email: 'otro@example.com' },
        ),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(contactRepository.save).not.toHaveBeenCalled();
    });

    it('con el mismo correo (en otras mayúsculas) no busca duplicados', async () => {
      await service.updateContact(
        personalAuthorization(),
        'account-personal',
        'contact-1',
        { email: 'ANA@example.com' },
      );

      expect(contactRepository.exists).not.toHaveBeenCalled();
    });
  });

  describe('archiveContact', () => {
    it('fija archivedAt y la autoría, sin borrar la fila', async () => {
      contactRepository.findOne.mockResolvedValue(contact());

      const result = await service.archiveContact(
        organizationAuthorization('account-a'),
        'account-a',
        'contact-1',
      );

      expect(result.archivedAt).toBeInstanceOf(Date);
      expect(contactRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'contact-1',
          updatedByAccountId: 'account-a',
        }),
      );
    });

    it('un contacto ya archivado responde 404', async () => {
      contactRepository.findOne.mockResolvedValue(null);

      await expect(
        service.archiveContact(
          personalAuthorization(),
          'account-personal',
          'contact-1',
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('utilidades', () => {
    it('normalizeContactEmail recorta y pasa a minúsculas', () => {
      expect(normalizeContactEmail('  Ana@Example.COM ')).toBe(
        'ana@example.com',
      );
    });

    it('escapeLikePattern escapa %, _ y \\', () => {
      expect(escapeLikePattern('a%b_c\\d')).toBe('a\\%b\\_c\\\\d');
    });
  });
});
