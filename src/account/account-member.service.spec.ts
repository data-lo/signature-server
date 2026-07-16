import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { AccountMemberService } from './account-member.service';
import { AccountMemberEntity } from './entities/account-member.entity';
import { AccountService } from './account.service';
import { ACCOUNT_MEMBER_ROLE_ENUM } from './enums/account-member-role.enum';

function createMockRepository() {
  return {
    findOne: jest.fn(),
    find: jest.fn(),
    create: jest.fn((_entity, data) => data ?? _entity),
    save: jest.fn(),
    update: jest.fn(),
  };
}

function ownerMembership(overrides: Partial<AccountMemberEntity> = {}) {
  return {
    id: 'owner-membership-1',
    userId: 'owner-1',
    accountId: 'account-1',
    role: [ACCOUNT_MEMBER_ROLE_ENUM.OWNER],
    isActive: true,
    ...overrides,
  };
}

describe('AccountMemberService', () => {
  let service: AccountMemberService;
  let accountMemberRepository: ReturnType<typeof createMockRepository>;
  let accountService: { removeAccountFromCatalog: jest.Mock };

  beforeEach(async () => {
    accountMemberRepository = createMockRepository();
    accountService = { removeAccountFromCatalog: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AccountMemberService,
        {
          provide: getRepositoryToken(AccountMemberEntity),
          useValue: accountMemberRepository,
        },
        { provide: AccountService, useValue: accountService },
      ],
    }).compile();

    service = module.get<AccountMemberService>(AccountMemberService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('create', () => {
    it('rechaza con ConflictException si el usuario ya tiene acceso a la cuenta', async () => {
      accountMemberRepository.findOne
        .mockResolvedValueOnce(ownerMembership()) // ownership check del llamador
        .mockResolvedValueOnce({ id: 'existing' }); // ya existe la membresía a crear

      await expect(
        service.create('owner-1', {
          accountId: 'account-1',
          userId: 'user-1',
          role: [ACCOUNT_MEMBER_ROLE_ENUM.ADMIN],
        }),
      ).rejects.toThrow(ConflictException);
    });

    it('lanza ForbiddenException si el llamador no es OWNER activo de la cuenta', async () => {
      accountMemberRepository.findOne.mockResolvedValue(null);

      await expect(
        service.create('not-owner', {
          accountId: 'account-1',
          userId: 'user-1',
          role: [ACCOUNT_MEMBER_ROLE_ENUM.ADMIN],
        }),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe('findByAccount', () => {
    it('retorna los miembros si el llamador es OWNER activo de la cuenta', async () => {
      accountMemberRepository.findOne.mockResolvedValue(ownerMembership());
      accountMemberRepository.find.mockResolvedValue([ownerMembership()]);

      const result = await service.findByAccount('owner-1', 'account-1');

      expect(result.data).toHaveLength(1);
    });

    it('lanza ForbiddenException si el llamador no es OWNER activo de la cuenta', async () => {
      accountMemberRepository.findOne.mockResolvedValue(null);

      await expect(
        service.findByAccount('not-owner', 'account-1'),
      ).rejects.toThrow(ForbiddenException);
      expect(accountMemberRepository.find).not.toHaveBeenCalled();
    });
  });

  describe('findOne / update', () => {
    it('findOne permite al OWNER de la cuenta ver la membresía', async () => {
      accountMemberRepository.findOne
        .mockResolvedValueOnce({
          id: 'member-2',
          accountId: 'account-1',
          userId: 'user-2',
          isActive: true,
        }) // findEntityById
        .mockResolvedValueOnce(ownerMembership()); // ownership check

      const result = await service.findOne('owner-1', 'member-2');

      expect(result.data.id).toBe('member-2');
    });

    it('findOne lanza ForbiddenException si el llamador no es OWNER de esa cuenta', async () => {
      accountMemberRepository.findOne
        .mockResolvedValueOnce({
          id: 'member-2',
          accountId: 'account-1',
          userId: 'user-2',
          isActive: true,
        })
        .mockResolvedValueOnce(null);

      await expect(service.findOne('intruder', 'member-2')).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('update lanza ForbiddenException si el llamador no es OWNER de esa cuenta', async () => {
      accountMemberRepository.findOne
        .mockResolvedValueOnce({
          id: 'member-2',
          accountId: 'account-1',
          userId: 'user-2',
          isActive: true,
        })
        .mockResolvedValueOnce(null);

      await expect(
        service.update('intruder', 'member-2', {
          role: [ACCOUNT_MEMBER_ROLE_ENUM.ADMIN],
        }),
      ).rejects.toThrow(ForbiddenException);
      expect(accountMemberRepository.update).not.toHaveBeenCalled();
    });
  });

  describe('remove', () => {
    it('marca isActive=false y quita la cuenta del catálogo cacheado del usuario revocado', async () => {
      accountMemberRepository.findOne
        .mockResolvedValueOnce({
          id: 'member-1',
          accountId: 'account-1',
          userId: 'user-1',
          isActive: true,
        }) // membresía objetivo
        .mockResolvedValueOnce(ownerMembership()); // ownership check del llamador

      const result = await service.remove('owner-1', 'member-1');

      expect(accountMemberRepository.update).toHaveBeenCalledWith('member-1', {
        isActive: false,
      });
      expect(accountService.removeAccountFromCatalog).toHaveBeenCalledWith(
        'user-1',
        'account-1',
      );
      expect(result.success).toBe(true);
    });

    it('lanza NotFoundException si la membresía no existe o ya estaba revocada', async () => {
      accountMemberRepository.findOne.mockResolvedValue(null);

      await expect(service.remove('owner-1', 'missing-id')).rejects.toThrow(
        NotFoundException,
      );
      expect(accountService.removeAccountFromCatalog).not.toHaveBeenCalled();
    });

    it('lanza ForbiddenException si el llamador no es OWNER de la cuenta de esa membresía', async () => {
      accountMemberRepository.findOne
        .mockResolvedValueOnce({
          id: 'member-1',
          accountId: 'account-1',
          userId: 'user-1',
          isActive: true,
        })
        .mockResolvedValueOnce(null);

      await expect(service.remove('intruder', 'member-1')).rejects.toThrow(
        ForbiddenException,
      );
      expect(accountMemberRepository.update).not.toHaveBeenCalled();
      expect(accountService.removeAccountFromCatalog).not.toHaveBeenCalled();
    });
  });
});
