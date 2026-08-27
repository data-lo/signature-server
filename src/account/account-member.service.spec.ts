import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ForbiddenException } from '@nestjs/common';
import { AccountMemberService } from './account-member.service';
import { AccountEntity } from './entities/account.entity';
import { UserEntity } from 'src/user/entities/user.entity';
import { AccountService } from './account.service';
import { RolesService } from 'src/roles/roles.service';
import { SYSTEM_ROLE_NAME_ENUM } from 'src/roles/enums/system-role-name.enum';

const ADMIN_ROLE = { id: 'admin-role-1', name: SYSTEM_ROLE_NAME_ENUM.ADMIN };
const MEMBER_ROLE = { id: 'member-role-1', name: SYSTEM_ROLE_NAME_ENUM.MEMBER };

function createMockRepository() {
  return {
    findOne: jest.fn(),
    find: jest.fn(),
    count: jest.fn(),
    create: jest.fn((data) => data),
    save: jest.fn(async (data) => ({ id: 'new-member-1', ...data })),
    update: jest.fn(),
  };
}

describe('AccountMemberService', () => {
  let service: AccountMemberService;
  let accountRepository: ReturnType<typeof createMockRepository>;
  let userRepository: ReturnType<typeof createMockRepository>;
  let accountService: { removeAccountFromCatalog: jest.Mock };
  let rolesService: {
    findByIdOrFail: jest.Mock;
    assertHasPermission: jest.Mock;
    findSystemRoleByName: jest.Mock;
  };

  beforeEach(async () => {
    accountRepository = createMockRepository();
    userRepository = createMockRepository();
    accountRepository.count.mockResolvedValue(2); // por defecto: hay más de un ADMIN activo, nada que proteger
    accountService = { removeAccountFromCatalog: jest.fn() };
    rolesService = {
      findByIdOrFail: jest.fn().mockResolvedValue(MEMBER_ROLE),
      findSystemRoleByName: jest.fn().mockResolvedValue(ADMIN_ROLE),
      // Espeja el seed real: ADMIN tiene los 12 permisos (incluye todo ORGANIZATION),
      // cualquier otro rol (o su ausencia) no tiene ninguno — ver RolesService.hasPermission.
      assertHasPermission: jest
        .fn()
        .mockImplementation(
          async (
            roleId: string | null | undefined,
            _resource,
            _action,
            message,
          ) => {
            if (roleId !== ADMIN_ROLE.id) {
              throw new ForbiddenException(
                message ??
                  'No tienes permisos suficientes para realizar esta acción',
              );
            }
          },
        ),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AccountMemberService,
        {
          provide: getRepositoryToken(AccountEntity),
          useValue: accountRepository,
        },
        {
          provide: getRepositoryToken(UserEntity),
          useValue: userRepository,
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

  describe('assertIsActiveMember', () => {
    it('retorna la cuenta si el usuario es un miembro activo (sin importar su rol)', async () => {
      accountRepository.findOne.mockResolvedValue({
        id: 'account-1',
        userId: 'user-1',
        organizationId: null,
        roleId: MEMBER_ROLE.id,
        isActive: true,
      });

      const result = await service.assertIsActiveMember('user-1', 'account-1');
      expect(result.id).toBe('account-1');
    });

    it('lanza ForbiddenException si el usuario no es miembro activo', async () => {
      accountRepository.findOne.mockResolvedValue(null);

      await expect(
        service.assertIsActiveMember('user-1', 'account-1'),
      ).rejects.toThrow(ForbiddenException);
    });
  });
});
