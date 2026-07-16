import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm';
import { AccountService } from './account.service';
import { AccountEntity } from './entities/account.entity';
import { OrganizationDetailEntity } from './entities/organization-detail.entity';
import { AccountMemberEntity } from './entities/account-member.entity';
import { RedisService } from 'src/shared/redis/redis.service';
import { ACCOUNT_TYPE_ENUM } from './enums/account-type.enum';
import { RolesService } from 'src/roles/roles.service';
import { SYSTEM_ROLE_NAME_ENUM } from 'src/roles/enums/system-role-name.enum';

const ADMIN_ROLE = { id: 'admin-role-1', name: SYSTEM_ROLE_NAME_ENUM.ADMIN };

function createMockRepository() {
  return {
    findOne: jest.fn(),
    find: jest.fn(),
    create: jest.fn(),
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
  let organizationDetailRepository: ReturnType<typeof createMockRepository>;
  let accountMemberRepository: ReturnType<typeof createMockRepository>;
  let dataSource: { createQueryRunner: jest.Mock };
  let queryRunner: ReturnType<typeof createMockQueryRunner>;
  let redisService: { set: jest.Mock; get: jest.Mock };
  let rolesService: {
    findSystemRoleByName: jest.Mock;
    findByIdOrFail: jest.Mock;
  };

  beforeEach(async () => {
    accountRepository = createMockRepository();
    organizationDetailRepository = createMockRepository();
    accountMemberRepository = createMockRepository();
    queryRunner = createMockQueryRunner();
    dataSource = { createQueryRunner: jest.fn(() => queryRunner) };
    redisService = { set: jest.fn(), get: jest.fn() };
    rolesService = {
      findSystemRoleByName: jest.fn().mockResolvedValue(ADMIN_ROLE),
      findByIdOrFail: jest.fn().mockResolvedValue({ id: 'member-role-1' }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AccountService,
        {
          provide: getRepositoryToken(AccountEntity),
          useValue: accountRepository,
        },
        {
          provide: getRepositoryToken(OrganizationDetailEntity),
          useValue: organizationDetailRepository,
        },
        {
          provide: getRepositoryToken(AccountMemberEntity),
          useValue: accountMemberRepository,
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
    it('crea Account(PERSONAL) + AccountMember(rol ADMIN) usando el manager del llamador', async () => {
      const manager = {
        create: jest.fn((_entity, data) => data),
        save: jest.fn(async (data) => ({ id: 'personal-account-1', ...data })),
      };

      const { account, membership } =
        await service.createDefaultPersonalAccount(
          manager as any,
          'user-1',
          'Juan Pérez',
        );

      expect(manager.save).toHaveBeenCalledTimes(2);
      expect(account.type).toBe(ACCOUNT_TYPE_ENUM.PERSONAL);
      expect(account.name).toBe('Juan Pérez');
      expect(rolesService.findSystemRoleByName).toHaveBeenCalledWith(
        SYSTEM_ROLE_NAME_ENUM.ADMIN,
      );

      const memberSaveCall = manager.save.mock.calls[1][0];
      expect(memberSaveCall.roleId).toBe('admin-role-1');
      expect(memberSaveCall.accountId).toBe('personal-account-1');
      expect(memberSaveCall.userId).toBe('user-1');
      expect(memberSaveCall.isActive).toBe(true);

      expect(membership.roleId).toBe('admin-role-1');
      expect(membership.isActive).toBe(true);
    });
  });

  describe('createOrganization', () => {
    const dto = { name: 'Acme', organizationName: 'Acme Corp S.A. de C.V.' };

    it('crea Account + OrganizationDetail + AccountMember(rol ADMIN) dentro de una transacción y refresca el catálogo en Redis', async () => {
      accountRepository.findOne.mockResolvedValue({
        id: 'generated-id',
        name: 'Acme',
        type: ACCOUNT_TYPE_ENUM.ORGANIZATION,
        createdAt: new Date('2026-01-01'),
        organizationDetail: { name: 'Acme Corp S.A. de C.V.' },
      });
      redisService.get.mockResolvedValue(null);

      const result = await service.createOrganization('user-1', dto);

      expect(dataSource.createQueryRunner).toHaveBeenCalled();
      expect(queryRunner.startTransaction).toHaveBeenCalled();
      expect(queryRunner.manager.save).toHaveBeenCalledTimes(3);
      expect(queryRunner.commitTransaction).toHaveBeenCalled();
      expect(queryRunner.rollbackTransaction).not.toHaveBeenCalled();

      const memberSaveCall = queryRunner.manager.save.mock.calls[2][0];
      expect(memberSaveCall.roleId).toBe('admin-role-1');
      expect(memberSaveCall.userId).toBe('user-1');
      expect(memberSaveCall.isActive).toBe(true);

      const [, cachedValue] = redisService.set.mock.calls[0];
      const cachedCatalog = JSON.parse(cachedValue);
      expect(cachedCatalog[0].roleId).toBe('admin-role-1');
      expect(cachedCatalog[0].isActive).toBe(true);
      expect(result.success).toBe(true);

      // La respuesta HTTP debe incluir roleId/isActive igual que el catálogo
      // cacheado (antes devolvía la AccountEntity cruda, sin estos campos).
      expect(result.data.roleId).toBe('admin-role-1');
      expect(result.data.isActive).toBe(true);
    });

    it('hace rollback si falla la creación de la membresía', async () => {
      queryRunner.manager.save = jest
        .fn()
        .mockResolvedValueOnce({ id: 'account-1' }) // Account
        .mockResolvedValueOnce({ accountId: 'account-1' }) // OrganizationDetail
        .mockRejectedValueOnce(new Error('duplicate key value')); // AccountMember

      await expect(service.createOrganization('user-1', dto)).rejects.toThrow(
        'duplicate key value',
      );
      expect(queryRunner.rollbackTransaction).toHaveBeenCalled();
      expect(queryRunner.commitTransaction).not.toHaveBeenCalled();
      expect(queryRunner.release).toHaveBeenCalled();
    });
  });

  describe('update', () => {
    const existingAccount = {
      id: 'account-1',
      name: 'Acme',
      type: ACCOUNT_TYPE_ENUM.ORGANIZATION,
      createdAt: new Date('2026-01-01'),
      organizationDetail: { name: 'Acme Corp S.A. de C.V.' },
    };
    const renamedAccount = {
      ...existingAccount,
      name: 'Acme Renombrada',
      organizationDetail: { name: 'Acme Renombrada S.A. de C.V.' },
    };
    const adminMembership = {
      userId: 'owner-1',
      accountId: 'account-1',
      roleId: 'admin-role-1',
      role: ADMIN_ROLE,
      isActive: true,
    };

    it('refresca el catálogo de cada miembro activo cuando cambia el nombre', async () => {
      accountMemberRepository.findOne.mockResolvedValue(adminMembership);
      accountRepository.findOne
        .mockResolvedValueOnce(existingAccount)
        .mockResolvedValueOnce(renamedAccount);
      accountMemberRepository.find.mockResolvedValue([
        { userId: 'user-1', accountId: 'account-1', isActive: true },
        { userId: 'user-2', accountId: 'account-1', isActive: true },
      ]);
      redisService.get.mockResolvedValue(
        JSON.stringify([
          {
            id: 'account-1',
            name: 'Acme',
            roleId: 'admin-role-1',
            isActive: true,
          },
        ]),
      );

      await service.update('owner-1', 'account-1', {
        name: 'Acme Renombrada',
        organizationName: 'Acme Renombrada S.A. de C.V.',
      });

      expect(accountMemberRepository.find).toHaveBeenCalledWith({
        where: { accountId: 'account-1', isActive: true },
      });
      expect(redisService.set).toHaveBeenCalledTimes(2);
      const [, firstValue] = redisService.set.mock.calls[0];
      const updatedEntry = JSON.parse(firstValue)[0];
      expect(updatedEntry.name).toBe('Acme Renombrada');
      expect(updatedEntry.roleId).toBe('admin-role-1');
      expect(updatedEntry.isActive).toBe(true);
    });

    it('no toca Redis si no se actualizó name ni organizationName', async () => {
      accountMemberRepository.findOne.mockResolvedValue(adminMembership);
      accountRepository.findOne
        .mockResolvedValueOnce(existingAccount)
        .mockResolvedValueOnce(existingAccount);

      await service.update('owner-1', 'account-1', {});

      expect(accountMemberRepository.find).not.toHaveBeenCalled();
      expect(redisService.set).not.toHaveBeenCalled();
    });

    it('lanza ForbiddenException si el llamador no es ADMIN activo de la cuenta', async () => {
      accountMemberRepository.findOne.mockResolvedValue(null);

      await expect(
        service.update('intruder', 'account-1', { name: 'Hackeada' }),
      ).rejects.toThrow(ForbiddenException);
      expect(accountRepository.update).not.toHaveBeenCalled();
    });
  });

  describe('findOne', () => {
    it('retorna la cuenta si el llamador es ADMIN activo', async () => {
      accountMemberRepository.findOne.mockResolvedValue({
        userId: 'owner-1',
        accountId: 'account-1',
        roleId: 'admin-role-1',
        role: ADMIN_ROLE,
        isActive: true,
      });
      accountRepository.findOne.mockResolvedValue({
        id: 'account-1',
        name: 'Acme',
        type: ACCOUNT_TYPE_ENUM.ORGANIZATION,
        createdAt: new Date('2026-01-01'),
        organizationDetail: { name: 'Acme Corp S.A. de C.V.' },
      });

      const result = await service.findOne('owner-1', 'account-1');

      expect(result.data.id).toBe('account-1');
    });

    it('lanza ForbiddenException si el llamador no es ADMIN activo de la cuenta', async () => {
      accountMemberRepository.findOne.mockResolvedValue(null);

      await expect(service.findOne('intruder', 'account-1')).rejects.toThrow(
        ForbiddenException,
      );
      expect(accountRepository.findOne).not.toHaveBeenCalled();
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
      name: 'Acme',
      type: ACCOUNT_TYPE_ENUM.ORGANIZATION,
      createdAt: new Date('2026-01-01'),
      organizationDetail: { name: 'Acme Corp S.A. de C.V.' } as any,
      members: [],
    };

    it('agrega la cuenta a un catálogo existente', async () => {
      redisService.get.mockResolvedValue(
        JSON.stringify([
          { id: 'personal-1', type: ACCOUNT_TYPE_ENUM.PERSONAL },
        ]),
      );

      await service.appendAccountToCatalog('user-1', account, {
        roleId: 'admin-role-1',
        isActive: true,
      });

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

      await service.appendAccountToCatalog('user-1', account, {
        roleId: 'admin-role-1',
        isActive: true,
      });

      const [, value] = redisService.set.mock.calls[0];
      const saved = JSON.parse(value);
      expect(saved).toHaveLength(1);
    });

    it('no propaga el error si Redis falla', async () => {
      redisService.get.mockRejectedValue(new Error('ECONNREFUSED'));

      await expect(
        service.appendAccountToCatalog('user-1', account, {
          roleId: 'admin-role-1',
          isActive: true,
        }),
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

    it('responde éxito si el llamador es ADMIN de una organización y el roleId existe', async () => {
      accountMemberRepository.findOne.mockResolvedValue({
        userId: 'admin-1',
        accountId: 'org-1',
        roleId: ADMIN_ROLE.id,
        role: ADMIN_ROLE,
        isActive: true,
      });
      accountRepository.findOne.mockResolvedValue({
        id: 'org-1',
        type: ACCOUNT_TYPE_ENUM.ORGANIZATION,
      });

      const result = await service.inviteMember('admin-1', 'org-1', dto);

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
      expect(accountMemberRepository.findOne).not.toHaveBeenCalled();
    });

    it('lanza ForbiddenException si el llamador no es ADMIN de la cuenta', async () => {
      accountMemberRepository.findOne.mockResolvedValue(null);

      await expect(
        service.inviteMember('intruder', 'org-1', dto),
      ).rejects.toThrow(ForbiddenException);
    });

    it('lanza BadRequestException si la cuenta activa no es de tipo ORGANIZATION', async () => {
      accountMemberRepository.findOne.mockResolvedValue({
        userId: 'admin-1',
        accountId: 'personal-1',
        roleId: ADMIN_ROLE.id,
        role: ADMIN_ROLE,
        isActive: true,
      });
      accountRepository.findOne.mockResolvedValue({
        id: 'personal-1',
        type: ACCOUNT_TYPE_ENUM.PERSONAL,
      });

      await expect(
        service.inviteMember('admin-1', 'personal-1', dto),
      ).rejects.toThrow(BadRequestException);
      expect(rolesService.findByIdOrFail).not.toHaveBeenCalled();
    });

    it('lanza NotFoundException si el roleId no corresponde a un rol existente', async () => {
      accountMemberRepository.findOne.mockResolvedValue({
        userId: 'admin-1',
        accountId: 'org-1',
        roleId: ADMIN_ROLE.id,
        role: ADMIN_ROLE,
        isActive: true,
      });
      accountRepository.findOne.mockResolvedValue({
        id: 'org-1',
        type: ACCOUNT_TYPE_ENUM.ORGANIZATION,
      });
      rolesService.findByIdOrFail.mockRejectedValue(
        new NotFoundException('Rol con ID bad-role no encontrado'),
      );

      await expect(
        service.inviteMember('admin-1', 'org-1', {
          ...dto,
          roleId: 'bad-role',
        }),
      ).rejects.toThrow(NotFoundException);
    });
  });
});
