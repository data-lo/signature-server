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
import { RolesService } from 'src/roles/roles.service';
import { SYSTEM_ROLE_NAME_ENUM } from 'src/roles/enums/system-role-name.enum';

const ADMIN_ROLE = { id: 'admin-role-1', name: SYSTEM_ROLE_NAME_ENUM.ADMIN };
const MEMBER_ROLE = { id: 'member-role-1', name: SYSTEM_ROLE_NAME_ENUM.MEMBER };

function createMockRepository() {
  return {
    findOne: jest.fn(),
    find: jest.fn(),
    create: jest.fn((_entity, data) => data ?? _entity),
    save: jest.fn(),
    update: jest.fn(),
  };
}

function adminMembership(overrides: Partial<AccountMemberEntity> = {}) {
  return {
    id: 'admin-membership-1',
    userId: 'owner-1',
    accountId: 'account-1',
    roleId: ADMIN_ROLE.id,
    role: ADMIN_ROLE,
    isActive: true,
    ...overrides,
  };
}

describe('AccountMemberService', () => {
  let service: AccountMemberService;
  let accountMemberRepository: ReturnType<typeof createMockRepository>;
  let accountService: { removeAccountFromCatalog: jest.Mock };
  let rolesService: { findByIdOrFail: jest.Mock };

  beforeEach(async () => {
    accountMemberRepository = createMockRepository();
    accountService = { removeAccountFromCatalog: jest.fn() };
    rolesService = {
      findByIdOrFail: jest.fn().mockResolvedValue(MEMBER_ROLE),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AccountMemberService,
        {
          provide: getRepositoryToken(AccountMemberEntity),
          useValue: accountMemberRepository,
        },
        { provide: AccountService, useValue: accountService },
        { provide: RolesService, useValue: rolesService },
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
        .mockResolvedValueOnce(adminMembership()) // ownership check del llamador
        .mockResolvedValueOnce({ id: 'existing' }); // ya existe la membresía a crear

      await expect(
        service.create('owner-1', {
          accountId: 'account-1',
          userId: 'user-1',
          roleId: MEMBER_ROLE.id,
        }),
      ).rejects.toThrow(ConflictException);
    });

    it('lanza ForbiddenException si el llamador no es ADMIN activo de la cuenta', async () => {
      accountMemberRepository.findOne.mockResolvedValue(null);

      await expect(
        service.create('not-owner', {
          accountId: 'account-1',
          userId: 'user-1',
          roleId: MEMBER_ROLE.id,
        }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('lanza NotFoundException si el roleId no corresponde a un rol existente', async () => {
      accountMemberRepository.findOne.mockResolvedValue(adminMembership());
      rolesService.findByIdOrFail.mockRejectedValue(
        new NotFoundException('Rol con ID bad-role no encontrado'),
      );

      await expect(
        service.create('owner-1', {
          accountId: 'account-1',
          userId: 'user-1',
          roleId: 'bad-role',
        }),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('findByAccount', () => {
    it('retorna los miembros si el llamador es ADMIN activo de la cuenta', async () => {
      accountMemberRepository.findOne.mockResolvedValue(adminMembership());
      accountMemberRepository.find.mockResolvedValue([adminMembership()]);

      const result = await service.findByAccount('owner-1', 'account-1');

      expect(result.data).toHaveLength(1);
    });

    it('lanza ForbiddenException si el llamador no es ADMIN activo de la cuenta', async () => {
      accountMemberRepository.findOne.mockResolvedValue(null);

      await expect(
        service.findByAccount('not-owner', 'account-1'),
      ).rejects.toThrow(ForbiddenException);
      expect(accountMemberRepository.find).not.toHaveBeenCalled();
    });
  });

  describe('findOne / update', () => {
    it('findOne permite al ADMIN de la cuenta ver la membresía', async () => {
      accountMemberRepository.findOne
        .mockResolvedValueOnce({
          id: 'member-2',
          accountId: 'account-1',
          userId: 'user-2',
          isActive: true,
        }) // findEntityById
        .mockResolvedValueOnce(adminMembership()); // ownership check

      const result = await service.findOne('owner-1', 'member-2');

      expect(result.data.id).toBe('member-2');
    });

    it('findOne lanza ForbiddenException si el llamador no es ADMIN de esa cuenta', async () => {
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

    it('update lanza ForbiddenException si el llamador no es ADMIN de esa cuenta', async () => {
      accountMemberRepository.findOne
        .mockResolvedValueOnce({
          id: 'member-2',
          accountId: 'account-1',
          userId: 'user-2',
          isActive: true,
        })
        .mockResolvedValueOnce(null);

      await expect(
        service.update('intruder', 'member-2', { roleId: MEMBER_ROLE.id }),
      ).rejects.toThrow(ForbiddenException);
      expect(accountMemberRepository.update).not.toHaveBeenCalled();
    });

    it('update lanza NotFoundException si el nuevo roleId no existe', async () => {
      accountMemberRepository.findOne
        .mockResolvedValueOnce({
          id: 'member-2',
          accountId: 'account-1',
          userId: 'user-2',
          isActive: true,
        })
        .mockResolvedValueOnce(adminMembership());
      rolesService.findByIdOrFail.mockRejectedValue(
        new NotFoundException('Rol con ID bad-role no encontrado'),
      );

      await expect(
        service.update('owner-1', 'member-2', { roleId: 'bad-role' }),
      ).rejects.toThrow(NotFoundException);
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
        .mockResolvedValueOnce(adminMembership()); // ownership check del llamador

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

    it('lanza ForbiddenException si el llamador no es ADMIN de la cuenta de esa membresía', async () => {
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

  describe('assertIsActiveMember', () => {
    it('no lanza si el usuario es un miembro activo (sin importar su rol)', async () => {
      accountMemberRepository.findOne.mockResolvedValue({
        userId: 'user-1',
        accountId: 'account-1',
        roleId: MEMBER_ROLE.id,
        isActive: true,
      });

      await expect(
        service.assertIsActiveMember('user-1', 'account-1'),
      ).resolves.toBeUndefined();
    });

    it('lanza ForbiddenException si el usuario no es miembro activo', async () => {
      accountMemberRepository.findOne.mockResolvedValue(null);

      await expect(
        service.assertIsActiveMember('user-1', 'account-1'),
      ).rejects.toThrow(ForbiddenException);
    });
  });
});
