import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ConflictException, NotFoundException } from '@nestjs/common';
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
      accountMemberRepository.findOne.mockResolvedValue({ id: 'existing' });

      await expect(
        service.create({
          accountId: 'account-1',
          userId: 'user-1',
          role: [ACCOUNT_MEMBER_ROLE_ENUM.ADMIN],
        }),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe('remove', () => {
    it('marca isActive=false y quita la cuenta del catálogo cacheado del usuario revocado', async () => {
      accountMemberRepository.findOne.mockResolvedValue({
        id: 'member-1',
        accountId: 'account-1',
        userId: 'user-1',
        isActive: true,
      });

      const result = await service.remove('member-1');

      expect(accountMemberRepository.update).toHaveBeenCalledWith(
        'member-1',
        { isActive: false },
      );
      expect(accountService.removeAccountFromCatalog).toHaveBeenCalledWith(
        'user-1',
        'account-1',
      );
      expect(result.success).toBe(true);
    });

    it('lanza NotFoundException si la membresía no existe o ya estaba revocada', async () => {
      accountMemberRepository.findOne.mockResolvedValue(null);

      await expect(service.remove('missing-id')).rejects.toThrow(
        NotFoundException,
      );
      expect(accountService.removeAccountFromCatalog).not.toHaveBeenCalled();
    });
  });
});
