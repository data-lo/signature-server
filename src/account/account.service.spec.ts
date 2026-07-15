import { Test, TestingModule } from '@nestjs/testing';
import { getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm';
import { AccountService } from './account.service';
import { AccountEntity } from './entities/account.entity';
import { OrganizationDetailEntity } from './entities/organization-detail.entity';
import { RedisService } from 'src/shared/redis/redis.service';
import { ACCOUNT_TYPE_ENUM } from './enums/account-type.enum';
import { ACCOUNT_MEMBER_ROLE_ENUM } from './enums/account-member-role.enum';

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
  let dataSource: { createQueryRunner: jest.Mock };
  let queryRunner: ReturnType<typeof createMockQueryRunner>;
  let redisService: { set: jest.Mock; get: jest.Mock };

  beforeEach(async () => {
    accountRepository = createMockRepository();
    organizationDetailRepository = createMockRepository();
    queryRunner = createMockQueryRunner();
    dataSource = { createQueryRunner: jest.fn(() => queryRunner) };
    redisService = { set: jest.fn(), get: jest.fn() };

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
        { provide: getDataSourceToken(), useValue: dataSource },
        { provide: RedisService, useValue: redisService },
      ],
    }).compile();

    service = module.get<AccountService>(AccountService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('createDefaultPersonalAccount', () => {
    it('crea Account(PERSONAL) + AccountMember(OWNER) usando el manager del llamador', async () => {
      const manager = {
        create: jest.fn((_entity, data) => data),
        save: jest.fn(async (data) => ({ id: 'personal-account-1', ...data })),
      };

      const account = await service.createDefaultPersonalAccount(
        manager as any,
        'user-1',
        'Juan Pérez',
      );

      expect(manager.save).toHaveBeenCalledTimes(2);
      expect(account.type).toBe(ACCOUNT_TYPE_ENUM.PERSONAL);
      expect(account.name).toBe('Juan Pérez');

      const memberSaveCall = manager.save.mock.calls[1][0];
      expect(memberSaveCall.role).toEqual([ACCOUNT_MEMBER_ROLE_ENUM.OWNER]);
      expect(memberSaveCall.accountId).toBe('personal-account-1');
      expect(memberSaveCall.userId).toBe('user-1');
    });
  });

  describe('createOrganization', () => {
    const dto = { name: 'Acme', organizationName: 'Acme Corp S.A. de C.V.' };

    it('crea Account + OrganizationDetail + AccountMember(role NULL) dentro de una transacción y refresca el catálogo en Redis', async () => {
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
      expect(memberSaveCall.role).toBeNull();
      expect(memberSaveCall.userId).toBe('user-1');

      expect(redisService.set).toHaveBeenCalledWith(
        'accounts:user-1',
        expect.any(String),
      );
      expect(result.success).toBe(true);
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

      await service.appendAccountToCatalog('user-1', account);

      const [key, value] = redisService.set.mock.calls[0];
      expect(key).toBe('accounts:user-1');
      const saved = JSON.parse(value);
      expect(saved).toHaveLength(2);
      expect(saved[1].id).toBe('account-1');
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
