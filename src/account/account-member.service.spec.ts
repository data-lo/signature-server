import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { AccountMemberService } from './account-member.service';
import { AccountEntity } from './entities/account.entity';
import { UserEntity } from 'src/user/entities/user.entity';
import { AccountService } from './account.service';
import { RolesService } from 'src/roles/roles.service';
import { SYSTEM_ROLE_NAME_ENUM } from 'src/roles/enums/system-role-name.enum';
import { ACCOUNT_TYPE_ENUM } from './enums/account-type.enum';

const ADMIN_ROLE = { id: 'admin-role-1', name: SYSTEM_ROLE_NAME_ENUM.ADMIN };
const MEMBER_ROLE = { id: 'member-role-1', name: SYSTEM_ROLE_NAME_ENUM.MEMBER };

function createMockRepository() {
  return {
    findOne: jest.fn(),
    find: jest.fn(),
    create: jest.fn((data) => data),
    save: jest.fn(async (data) => ({ id: 'new-member-1', ...data })),
    update: jest.fn(),
  };
}

function adminAccount(overrides: Partial<AccountEntity> = {}) {
  return {
    id: 'admin-account-1',
    userId: 'owner-1',
    accountType: ACCOUNT_TYPE_ENUM.ORGANIZATION,
    organizationId: 'org-1',
    roleId: ADMIN_ROLE.id,
    role: ADMIN_ROLE,
    isActive: true,
    ...overrides,
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
  };

  beforeEach(async () => {
    accountRepository = createMockRepository();
    userRepository = createMockRepository();
    accountService = { removeAccountFromCatalog: jest.fn() };
    rolesService = {
      findByIdOrFail: jest.fn().mockResolvedValue(MEMBER_ROLE),
      // Espeja el seed real: ADMIN tiene los 12 permisos (incluye todo ORGANIZATION),
      // cualquier otro rol (o su ausencia) no tiene ninguno — ver RolesService.hasPermission.
      assertHasPermission: jest
        .fn()
        .mockImplementation(
          async (roleId: string | null | undefined, _resource, _action, message) => {
            if (roleId !== ADMIN_ROLE.id) {
              throw new ForbiddenException(
                message ?? 'No tienes permisos suficientes para realizar esta acción',
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

  describe('create', () => {
    const dto = {
      organizationId: 'org-1',
      userId: 'user-1',
      roleId: MEMBER_ROLE.id,
    };

    it('rechaza con ConflictException si el usuario ya tiene acceso a la organización', async () => {
      accountRepository.findOne
        .mockResolvedValueOnce(adminAccount()) // ownership check del llamador
        .mockResolvedValueOnce({ id: 'existing' }); // ya existe la membresía a crear

      await expect(service.create('owner-1', dto)).rejects.toThrow(
        ConflictException,
      );
    });

    it('lanza ForbiddenException si el llamador no es ADMIN activo de la organización', async () => {
      accountRepository.findOne.mockResolvedValue(null);

      await expect(service.create('not-owner', dto)).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('lanza NotFoundException si el roleId no corresponde a un rol existente', async () => {
      accountRepository.findOne.mockResolvedValue(adminAccount());
      rolesService.findByIdOrFail.mockRejectedValue(
        new NotFoundException('Rol con ID bad-role no encontrado'),
      );

      await expect(
        service.create('owner-1', { ...dto, roleId: 'bad-role' }),
      ).rejects.toThrow(NotFoundException);
    });

    it('sincroniza email/password del usuario invitado (decisión D6, credencial única)', async () => {
      accountRepository.findOne
        .mockResolvedValueOnce(adminAccount())
        .mockResolvedValueOnce(null); // no existe membresía previa
      userRepository.findOne.mockResolvedValue({
        id: 'user-1',
        email: 'invitado@empresa.com',
        password: 'hashed-pw',
      });

      await service.create('owner-1', dto);

      expect(accountRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          email: 'invitado@empresa.com',
          password: 'hashed-pw',
          organizationId: 'org-1',
          userId: 'user-1',
        }),
      );
    });
  });

  describe('findByOrganization', () => {
    it('retorna los miembros si el llamador es ADMIN activo de la organización', async () => {
      accountRepository.findOne.mockResolvedValue(adminAccount());
      accountRepository.find.mockResolvedValue([adminAccount()]);

      const result = await service.findByOrganization('owner-1', 'org-1');

      expect(result.data).toHaveLength(1);
    });

    it('lanza ForbiddenException si el llamador no es ADMIN activo de la organización', async () => {
      accountRepository.findOne.mockResolvedValue(null);

      await expect(
        service.findByOrganization('not-owner', 'org-1'),
      ).rejects.toThrow(ForbiddenException);
      expect(accountRepository.find).not.toHaveBeenCalled();
    });
  });

  describe('findOne / update', () => {
    it('findOne permite al ADMIN de la organización ver la membresía', async () => {
      accountRepository.findOne
        .mockResolvedValueOnce({
          id: 'member-2',
          organizationId: 'org-1',
          userId: 'user-2',
          isActive: true,
        }) // findEntityById
        .mockResolvedValueOnce(adminAccount()); // ownership check

      const result = await service.findOne('owner-1', 'member-2');

      expect(result.data.id).toBe('member-2');
    });

    it('findOne lanza ForbiddenException si el llamador no es ADMIN de esa organización', async () => {
      accountRepository.findOne
        .mockResolvedValueOnce({
          id: 'member-2',
          organizationId: 'org-1',
          userId: 'user-2',
          isActive: true,
        })
        .mockResolvedValueOnce(null);

      await expect(service.findOne('intruder', 'member-2')).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('update lanza ForbiddenException si el llamador no es ADMIN de esa organización', async () => {
      accountRepository.findOne
        .mockResolvedValueOnce({
          id: 'member-2',
          organizationId: 'org-1',
          userId: 'user-2',
          isActive: true,
        })
        .mockResolvedValueOnce(null);

      await expect(
        service.update('intruder', 'member-2', { roleId: MEMBER_ROLE.id }),
      ).rejects.toThrow(ForbiddenException);
      expect(accountRepository.update).not.toHaveBeenCalled();
    });

    it('update lanza NotFoundException si el nuevo roleId no existe', async () => {
      accountRepository.findOne
        .mockResolvedValueOnce({
          id: 'member-2',
          organizationId: 'org-1',
          userId: 'user-2',
          isActive: true,
        })
        .mockResolvedValueOnce(adminAccount());
      rolesService.findByIdOrFail.mockRejectedValue(
        new NotFoundException('Rol con ID bad-role no encontrado'),
      );

      await expect(
        service.update('owner-1', 'member-2', { roleId: 'bad-role' }),
      ).rejects.toThrow(NotFoundException);
      expect(accountRepository.update).not.toHaveBeenCalled();
    });
  });

  describe('remove', () => {
    it('marca isActive=false y quita la cuenta del catálogo cacheado del usuario revocado', async () => {
      accountRepository.findOne
        .mockResolvedValueOnce({
          id: 'member-1',
          organizationId: 'org-1',
          userId: 'user-1',
          isActive: true,
        }) // membresía objetivo
        .mockResolvedValueOnce(adminAccount()); // ownership check del llamador

      const result = await service.remove('owner-1', 'member-1');

      expect(accountRepository.update).toHaveBeenCalledWith(
        'member-1',
        expect.objectContaining({ isActive: false }),
      );
      expect(accountService.removeAccountFromCatalog).toHaveBeenCalledWith(
        'user-1',
        'member-1',
      );
      expect(result.success).toBe(true);
    });

    it('lanza NotFoundException si la membresía no existe o ya estaba revocada', async () => {
      accountRepository.findOne.mockResolvedValue(null);

      await expect(service.remove('owner-1', 'missing-id')).rejects.toThrow(
        NotFoundException,
      );
      expect(accountService.removeAccountFromCatalog).not.toHaveBeenCalled();
    });

    it('lanza ForbiddenException si el llamador no es ADMIN de la organización de esa membresía', async () => {
      accountRepository.findOne
        .mockResolvedValueOnce({
          id: 'member-1',
          organizationId: 'org-1',
          userId: 'user-1',
          isActive: true,
        })
        .mockResolvedValueOnce(null);

      await expect(service.remove('intruder', 'member-1')).rejects.toThrow(
        ForbiddenException,
      );
      expect(accountRepository.update).not.toHaveBeenCalled();
      expect(accountService.removeAccountFromCatalog).not.toHaveBeenCalled();
    });
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
