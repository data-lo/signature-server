import { ForbiddenException, NotFoundException, BadRequestException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm';
import { AccountService } from './account.service';
import { AccountEntity } from './entities/account.entity';
import { OrganizationEntity } from './entities/organization.entity';
import { UserEntity } from 'src/user/entities/user.entity';
import { RedisService } from 'src/shared/redis/redis.service';
import { ACCOUNT_TYPE_ENUM } from './enums/account-type.enum';
import { RolesService } from 'src/roles/roles.service';
import { SYSTEM_ROLE_NAME_ENUM } from 'src/roles/enums/system-role-name.enum';

const ADMIN_ROLE = { id: 'admin-role-1', name: SYSTEM_ROLE_NAME_ENUM.ADMIN };
const CURRENT_USER = {
  id: 'user-1',
  email: 'user1@empresa.com',
  password: 'hashed-pw',
};

function createMockRepository() {
  return {
    findOne: jest.fn(),
    find: jest.fn(),
    create: jest.fn((data) => data),
    save: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
  };
}

function createMockQueryRunner() {
  return {
    connect: jest.fn(),
    startTransaction: jest.fn(),
    commitTransaction: jest.fn(),
    rollbackTransaction: jest.fn(),
    release: jest.fn(),
    manager: {
      create: jest.fn((_entity, data) => data),
      save: jest.fn(async (data) => ({ id: 'generated-id', ...data })),
    },
  };
}

describe('AccountService', () => {
  let service: AccountService;
  let accountRepository: ReturnType<typeof createMockRepository>;
  let organizationRepository: ReturnType<typeof createMockRepository>;
  let userRepository: ReturnType<typeof createMockRepository>;
  let dataSource: { createQueryRunner: jest.Mock };
  let queryRunner: ReturnType<typeof createMockQueryRunner>;
  let redisService: { set: jest.Mock; get: jest.Mock };
  let rolesService: {
    findSystemRoleByName: jest.Mock;
    findByIdOrFail: jest.Mock;
    hasPermission: jest.Mock;
  };

  beforeEach(async () => {
    accountRepository = createMockRepository();
    organizationRepository = createMockRepository();
    userRepository = createMockRepository();
    userRepository.findOne.mockResolvedValue(CURRENT_USER);
    queryRunner = createMockQueryRunner();
    dataSource = { createQueryRunner: jest.fn(() => queryRunner) };
    redisService = { set: jest.fn(), get: jest.fn() };
    rolesService = {
      findSystemRoleByName: jest.fn().mockResolvedValue(ADMIN_ROLE),
      findByIdOrFail: jest.fn().mockResolvedValue({ id: 'member-role-1' }),
      // Espeja el seed real: ADMIN tiene los 12 permisos (incluye todo ORGANIZATION),
      // cualquier otro rol (o su ausencia) no tiene ninguno — ver RolesService.hasPermission.
      hasPermission: jest
        .fn()
        .mockImplementation(async (roleId: string | null | undefined) =>
          roleId === ADMIN_ROLE.id,
        ),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AccountService,
        {
          provide: getRepositoryToken(AccountEntity),
          useValue: accountRepository,
        },
        {
          provide: getRepositoryToken(OrganizationEntity),
          useValue: organizationRepository,
        },
        {
          provide: getRepositoryToken(UserEntity),
          useValue: userRepository,
        },
        { provide: getDataSourceToken(), useValue: dataSource },
        { provide: RedisService, useValue: redisService },
        { provide: RolesService, useValue: rolesService },
      ],
    }).compile();

    service = module.get<AccountService>(AccountService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('createDefaultPersonalAccount', () => {
    it('crea Account(PERSONAL, rol ADMIN) con email/password sincronizados usando el manager del llamador', async () => {
      const manager = {
        create: jest.fn((_entity, data) => data),
        save: jest.fn(async (data) => ({ id: 'personal-account-1', ...data })),
      };

      const { account } = await service.createDefaultPersonalAccount(
        manager as any,
        'user-1',
        'user1@empresa.com',
        'hashed-pw',
      );

      expect(manager.save).toHaveBeenCalledTimes(1);
      expect(account.accountType).toBe(ACCOUNT_TYPE_ENUM.PERSONAL);
      expect(account.organizationId).toBeNull();
      expect(account.email).toBe('user1@empresa.com');
      expect(account.password).toBe('hashed-pw');
      expect(rolesService.findSystemRoleByName).toHaveBeenCalledWith(
        SYSTEM_ROLE_NAME_ENUM.ADMIN,
      );
      expect(account.roleId).toBe('admin-role-1');
      expect(account.isActive).toBe(true);
    });
  });

  describe('createOrganization', () => {
    const dto = { name: 'Acme', organizationName: 'Acme Corp S.A. de C.V.' };

    function mockFullAccountLookup() {
      accountRepository.findOne.mockResolvedValue({
        id: 'generated-id',
        accountType: ACCOUNT_TYPE_ENUM.ORGANIZATION,
        organizationId: 'generated-id-org',
        roleId: 'admin-role-1',
        isActive: true,
        createdAt: new Date('2026-01-01'),
        organization: { name: 'Acme Corp S.A. de C.V.' },
      });
    }

    it('crea Organization + Account(rol ADMIN) dentro de una transacción y refresca el catálogo en Redis', async () => {
      mockFullAccountLookup();
      redisService.get.mockResolvedValue(null);

      const result = await service.createOrganization('user-1', dto);

      expect(dataSource.createQueryRunner).toHaveBeenCalled();
      expect(queryRunner.startTransaction).toHaveBeenCalled();
      expect(queryRunner.manager.save).toHaveBeenCalledTimes(2);
      expect(queryRunner.commitTransaction).toHaveBeenCalled();
      expect(queryRunner.rollbackTransaction).not.toHaveBeenCalled();

      const accountSaveCall = queryRunner.manager.save.mock.calls[1][0];
      expect(accountSaveCall.roleId).toBe('admin-role-1');
      expect(accountSaveCall.userId).toBe('user-1');
      expect(accountSaveCall.isActive).toBe(true);
      expect(accountSaveCall.email).toBe('user1@empresa.com');
      expect(accountSaveCall.password).toBe('hashed-pw');

      const [, cachedValue] = redisService.set.mock.calls[0];
      const cachedCatalog = JSON.parse(cachedValue);
      expect(cachedCatalog[0].roleId).toBe('admin-role-1');
      expect(cachedCatalog[0].isActive).toBe(true);
      expect(result.success).toBe(true);
      expect(result.data.roleId).toBe('admin-role-1');
      expect(result.data.isActive).toBe(true);
    });

    it('persiste los campos opcionales de perfil de organización cuando se envían', async () => {
      mockFullAccountLookup();
      redisService.get.mockResolvedValue(null);

      const dtoConPerfil = {
        ...dto,
        address: 'Av. Reforma 123, CDMX',
        rfc: 'ACM010101AAA',
        domainAllowed: 'acme.com',
        phoneNumber: '5512345678',
        indexDocuments: true,
      };

      await service.createOrganization('user-1', dtoConPerfil);

      const organizationSaveCall = queryRunner.manager.save.mock.calls[0][0];
      expect(organizationSaveCall).toMatchObject({
        address: 'Av. Reforma 123, CDMX',
        rfc: 'ACM010101AAA',
        domainAllowed: 'acme.com',
        phoneNumber: '5512345678',
        indexDocuments: true,
      });
    });

    it('defaultea los campos opcionales de perfil de organización a null/false cuando se omiten', async () => {
      mockFullAccountLookup();
      redisService.get.mockResolvedValue(null);

      await service.createOrganization('user-1', dto);

      const organizationSaveCall = queryRunner.manager.save.mock.calls[0][0];
      expect(organizationSaveCall).toMatchObject({
        address: null,
        rfc: null,
        domainAllowed: null,
        phoneNumber: null,
        indexDocuments: false,
      });
    });

    it('hace rollback si falla la creación de la cuenta', async () => {
      queryRunner.manager.save = jest
        .fn()
        .mockResolvedValueOnce({ id: 'org-1' }) // Organization
        .mockRejectedValueOnce(new Error('duplicate key value')); // Account

      await expect(service.createOrganization('user-1', dto)).rejects.toThrow(
        'duplicate key value',
      );
      expect(queryRunner.rollbackTransaction).toHaveBeenCalled();
      expect(queryRunner.commitTransaction).not.toHaveBeenCalled();
      expect(queryRunner.release).toHaveBeenCalled();
    });
  });

  describe('update', () => {
    const adminAccount = {
      id: 'account-1',
      userId: 'owner-1',
      accountType: ACCOUNT_TYPE_ENUM.ORGANIZATION,
      organizationId: 'org-1',
      roleId: 'admin-role-1',
      role: ADMIN_ROLE,
      isActive: true,
      createdAt: new Date('2026-01-01'),
      organization: { name: 'Acme Corp S.A. de C.V.' },
    };
    const renamedAccount = {
      ...adminAccount,
      organization: { name: 'Acme Renombrada S.A. de C.V.' },
    };

    it('refresca el catálogo de cada miembro activo cuando cambia el nombre de la organización', async () => {
      accountRepository.findOne
        .mockResolvedValueOnce(adminAccount) // assertHasOrganizationPermission
        .mockResolvedValueOnce(renamedAccount); // findEntityById tras el update
      accountRepository.find.mockResolvedValue([
        { id: 'account-1', userId: 'user-1', organizationId: 'org-1', isActive: true },
        { id: 'account-2', userId: 'user-2', organizationId: 'org-1', isActive: true },
      ]);
      redisService.get.mockResolvedValue(
        JSON.stringify([
          {
            id: 'account-1',
            roleId: 'admin-role-1',
            isActive: true,
          },
        ]),
      );

      await service.update('owner-1', 'account-1', {
        organizationName: 'Acme Renombrada S.A. de C.V.',
      });

      expect(accountRepository.find).toHaveBeenCalledWith({
        where: { organizationId: 'org-1', isActive: true },
        relations: { organization: true },
      });
      expect(redisService.set).toHaveBeenCalled();
    });

    it('no toca Redis si no se actualizó ningún campo de perfil', async () => {
      accountRepository.findOne
        .mockResolvedValueOnce(adminAccount)
        .mockResolvedValueOnce(adminAccount);

      await service.update('owner-1', 'account-1', {});

      expect(accountRepository.find).not.toHaveBeenCalled();
      expect(redisService.set).not.toHaveBeenCalled();
    });

    it('lanza ForbiddenException si el llamador no es ADMIN activo de la cuenta', async () => {
      accountRepository.findOne.mockResolvedValue(null);

      await expect(
        service.update('intruder', 'account-1', { organizationName: 'Hackeada' }),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe('findOne', () => {
    it('retorna la cuenta si el llamador es ADMIN activo (dueño de esa fila)', async () => {
      accountRepository.findOne.mockResolvedValue({
        id: 'account-1',
        userId: 'owner-1',
        accountType: ACCOUNT_TYPE_ENUM.ORGANIZATION,
        organizationId: 'org-1',
        roleId: 'admin-role-1',
        role: ADMIN_ROLE,
        isActive: true,
        createdAt: new Date('2026-01-01'),
        organization: { name: 'Acme Corp S.A. de C.V.' },
      });

      const result = await service.findOne('owner-1', 'account-1');

      expect(result.data.id).toBe('account-1');
    });

    it('lanza ForbiddenException si el llamador no es ADMIN activo de la cuenta', async () => {
      accountRepository.findOne.mockResolvedValue(null);

      await expect(service.findOne('intruder', 'account-1')).rejects.toThrow(
        ForbiddenException,
      );
    });
  });

  describe('removeAccountFromCatalog', () => {
    it('quita la cuenta del catálogo cacheado del usuario', async () => {
      redisService.get.mockResolvedValue(
        JSON.stringify([{ id: 'account-1' }, { id: 'account-2' }]),
      );

      await service.removeAccountFromCatalog('user-1', 'account-1');

      const [key, value] = redisService.set.mock.calls[0];
      expect(key).toBe('accounts:user-1');
      const saved = JSON.parse(value);
      expect(saved).toEqual([{ id: 'account-2' }]);
    });

    it('no escribe en Redis si la cuenta no estaba en el catálogo', async () => {
      redisService.get.mockResolvedValue(JSON.stringify([{ id: 'account-2' }]));

      await service.removeAccountFromCatalog('user-1', 'account-1');

      expect(redisService.set).not.toHaveBeenCalled();
    });

    it('no propaga el error si Redis falla', async () => {
      redisService.get.mockRejectedValue(new Error('ECONNREFUSED'));

      await expect(
        service.removeAccountFromCatalog('user-1', 'account-1'),
      ).resolves.toBeUndefined();
    });
  });

  describe('appendAccountToCatalog', () => {
    const account: AccountEntity = {
      id: 'account-1',
      userId: 'user-1',
      accountType: ACCOUNT_TYPE_ENUM.ORGANIZATION,
      organizationId: 'org-1',
      roleId: 'admin-role-1',
      createdAt: new Date('2026-01-01'),
      isActive: true,
      organization: { name: 'Acme Corp S.A. de C.V.' } as any,
    } as AccountEntity;

    it('agrega la cuenta a un catálogo existente', async () => {
      redisService.get.mockResolvedValue(
        JSON.stringify([
          { id: 'personal-1', type: ACCOUNT_TYPE_ENUM.PERSONAL },
        ]),
      );

      await service.appendAccountToCatalog('user-1', account);

      const [key, value] = redisService.set.mock.calls[0];
      expect(key).toBe('accounts:user-1');
      const saved = JSON.parse(value);
      expect(saved).toHaveLength(2);
      expect(saved[1].id).toBe('account-1');
      expect(saved[1].roleId).toBe('admin-role-1');
      expect(saved[1].isActive).toBe(true);
    });

    it('empieza un catálogo nuevo si la key no existe en Redis', async () => {
      redisService.get.mockResolvedValue(null);

      await service.appendAccountToCatalog('user-1', account);

      const [, value] = redisService.set.mock.calls[0];
      const saved = JSON.parse(value);
      expect(saved).toHaveLength(1);
    });

    it('no propaga el error si Redis falla', async () => {
      redisService.get.mockRejectedValue(new Error('ECONNREFUSED'));

      await expect(
        service.appendAccountToCatalog('user-1', account),
      ).resolves.toBeUndefined();
    });
  });

  describe('getAccountsCatalog', () => {
    it('retorna el catálogo cacheado en Redis', async () => {
      redisService.get.mockResolvedValue(
        JSON.stringify([
          { id: 'personal-1', type: ACCOUNT_TYPE_ENUM.PERSONAL },
        ]),
      );

      const result = await service.getAccountsCatalog('user-1');

      expect(redisService.get).toHaveBeenCalledWith('accounts:user-1');
      expect(result.data).toHaveLength(1);
    });

    it('retorna un catálogo vacío si la key no existe en Redis', async () => {
      redisService.get.mockResolvedValue(null);

      const result = await service.getAccountsCatalog('user-1');

      expect(result.data).toEqual([]);
    });
  });

  describe('inviteMember', () => {
    const dto = { email: 'nuevo@empresa.com', roleId: 'member-role-1' };
    const adminOrgAccount = {
      id: 'org-account-1',
      userId: 'admin-1',
      accountType: ACCOUNT_TYPE_ENUM.ORGANIZATION,
      organizationId: 'org-1',
      roleId: ADMIN_ROLE.id,
      role: ADMIN_ROLE,
      isActive: true,
    };
    const adminPersonalAccount = {
      id: 'personal-account-1',
      userId: 'admin-1',
      accountType: ACCOUNT_TYPE_ENUM.PERSONAL,
      organizationId: null,
      roleId: ADMIN_ROLE.id,
      role: ADMIN_ROLE,
      isActive: true,
    };

    it('responde éxito si el llamador es ADMIN de una organización y el roleId existe', async () => {
      accountRepository.findOne.mockResolvedValue(adminOrgAccount);

      const result = await service.inviteMember('admin-1', 'org-account-1', dto);

      expect(rolesService.findByIdOrFail).toHaveBeenCalledWith('member-role-1');
      expect(result).toEqual({
        success: true,
        message: 'Invitación registrada correctamente',
        data: null,
      });
    });

    it('lanza BadRequestException si falta accountId (header X-Account-Id)', async () => {
      await expect(service.inviteMember('admin-1', '', dto)).rejects.toThrow(
        BadRequestException,
      );
      expect(accountRepository.findOne).not.toHaveBeenCalled();
    });

    it('lanza ForbiddenException si el llamador no es ADMIN de la cuenta', async () => {
      accountRepository.findOne.mockResolvedValue(null);

      await expect(
        service.inviteMember('intruder', 'org-account-1', dto),
      ).rejects.toThrow(ForbiddenException);
    });

    it('lanza BadRequestException si la cuenta activa no es de tipo ORGANIZATION', async () => {
      accountRepository.findOne.mockResolvedValue(adminPersonalAccount);

      await expect(
        service.inviteMember('admin-1', 'personal-account-1', dto),
      ).rejects.toThrow(BadRequestException);
      expect(rolesService.findByIdOrFail).not.toHaveBeenCalled();
    });

    it('lanza NotFoundException si el roleId no corresponde a un rol existente', async () => {
      accountRepository.findOne.mockResolvedValue(adminOrgAccount);
      rolesService.findByIdOrFail.mockRejectedValue(
        new NotFoundException('Rol con ID bad-role no encontrado'),
      );

      await expect(
        service.inviteMember('admin-1', 'org-account-1', {
          ...dto,
          roleId: 'bad-role',
        }),
      ).rejects.toThrow(NotFoundException);
    });
  });
});
