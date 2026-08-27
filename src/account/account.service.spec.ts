import { ForbiddenException, NotFoundException } from '@nestjs/common';
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
import { ACTION_KEY_ENUM } from 'src/roles/enums/action-key.enum';

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
        .mockImplementation(
          async (roleId: string | null | undefined) => roleId === ADMIN_ROLE.id,
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

  describe('saveOrganizationWithAdminAccount', () => {
    const dto = { name: 'Acme', organizationName: 'Acme Corp S.A. de C.V.' };

    it('guarda organizacion y cuenta ADMIN en una sola transaccion', async () => {
      accountRepository.findOne.mockResolvedValue({
        id: 'generated-id',
        organization: { name: 'Acme Corp S.A. de C.V.' },
      });

      await service.saveOrganizationWithAdminAccount(
        CURRENT_USER as never,
        dto as never,
      );

      expect(queryRunner.startTransaction).toHaveBeenCalled();
      expect(queryRunner.manager.save).toHaveBeenCalledTimes(2);
      expect(queryRunner.commitTransaction).toHaveBeenCalled();
      expect(queryRunner.release).toHaveBeenCalled();
    });

    /**
     * Una organización sin ningún administrador no la puede gestionar nadie, y no habría forma
     * de repararla desde la API.
     */
    it('hace rollback si falla el save de la cuenta', async () => {
      queryRunner.manager.save = jest
        .fn()
        .mockResolvedValueOnce({ id: 'org-1' })
        .mockRejectedValueOnce(new Error('duplicate key value'));

      await expect(
        service.saveOrganizationWithAdminAccount(
          CURRENT_USER as never,
          dto as never,
        ),
      ).rejects.toThrow('duplicate key value');
      expect(queryRunner.rollbackTransaction).toHaveBeenCalled();
      expect(queryRunner.commitTransaction).not.toHaveBeenCalled();
      expect(queryRunner.release).toHaveBeenCalled();
    });
  });

  describe('assertHasOrganizationPermission', () => {
    it('devuelve la cuenta si el llamador es su dueno con rol ADMIN', async () => {
      const account = {
        id: 'account-1',
        userId: 'owner-1',
        roleId: ADMIN_ROLE.id,
        role: ADMIN_ROLE,
        isActive: true,
      };
      accountRepository.findOne.mockResolvedValue(account);

      const result = await service.assertHasOrganizationPermission(
        'owner-1',
        'account-1',
        ACTION_KEY_ENUM.READ,
      );

      expect(result).toBe(account);
    });

    /**
     * La búsqueda filtra por `userId`, así que pedir la fila de otro usuario no la encuentra y
     * da 403 sin revelar nada de ella.
     */
    it('lanza ForbiddenException si la cuenta no es del llamador', async () => {
      accountRepository.findOne.mockResolvedValue(null);

      await expect(
        service.assertHasOrganizationPermission(
          'intruder',
          'account-1',
          ACTION_KEY_ENUM.READ,
        ),
      ).rejects.toThrow(ForbiddenException);
    });

    it('lanza ForbiddenException si el rol no tiene ese permiso', async () => {
      accountRepository.findOne.mockResolvedValue({
        id: 'account-1',
        userId: 'owner-1',
        roleId: 'member-role-1',
        isActive: true,
      });

      await expect(
        service.assertHasOrganizationPermission(
          'owner-1',
          'account-1',
          ACTION_KEY_ENUM.DELETE,
        ),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe('findByIdOrFail', () => {
    it('lanza NotFoundException si la cuenta no existe', async () => {
      accountRepository.findOne.mockResolvedValue(null);

      await expect(service.findByIdOrFail('missing')).rejects.toThrow(
        NotFoundException,
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
});
