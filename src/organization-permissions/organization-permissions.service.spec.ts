import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken, getDataSourceToken } from '@nestjs/typeorm';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { OrganizationPermissionsService } from './organization-permissions.service';
import { OrganizationPermissionEntity } from './entities/organization-permission.entity';
import { AccountPermissionEntity } from './entities/account-permission.entity';
import { AccountEntity } from 'src/account/entities/account.entity';
import { RolesService } from 'src/roles/roles.service';
import { ACTION_KEY_ENUM } from 'src/roles/enums/action-key.enum';

const ADMIN_ROLE_ID = 'admin-role-1';

function createMockRepository() {
  return {
    findOne: jest.fn(),
    find: jest.fn(),
    create: jest.fn((data) => data),
    save: jest.fn(async (data) => ({ id: 'permission-new', ...data })),
    update: jest.fn(),
    delete: jest.fn(),
    insert: jest.fn(),
  };
}

function adminMembership(overrides: Partial<AccountEntity> = {}) {
  return {
    id: 'admin-account-1',
    userId: 'owner-1',
    organizationId: 'org-1',
    roleId: ADMIN_ROLE_ID,
    isActive: true,
    ...overrides,
  };
}

describe('OrganizationPermissionsService', () => {
  let service: OrganizationPermissionsService;
  let organizationPermissionRepository: ReturnType<typeof createMockRepository>;
  let accountPermissionRepository: ReturnType<typeof createMockRepository>;
  let accountRepository: ReturnType<typeof createMockRepository>;
  let manager: { getRepository: jest.Mock };
  let dataSource: { transaction: jest.Mock };
  let rolesService: { assertHasPermission: jest.Mock };

  beforeEach(async () => {
    organizationPermissionRepository = createMockRepository();
    accountPermissionRepository = createMockRepository();
    accountRepository = createMockRepository();
    manager = {
      getRepository: jest.fn().mockReturnValue(accountPermissionRepository),
    };
    dataSource = {
      transaction: jest.fn(async (cb: (manager: unknown) => Promise<unknown>) =>
        cb(manager),
      ),
    };
    rolesService = {
      // Espeja el seed real: ADMIN tiene todos los permisos ORGANIZATION, cualquier otro rol
      // (o su ausencia) no tiene ninguno — ver RolesService.hasPermission.
      assertHasPermission: jest
        .fn()
        .mockImplementation(
          async (
            roleId: string | null | undefined,
            _resource,
            _action,
            message,
          ) => {
            if (roleId !== ADMIN_ROLE_ID) {
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
        OrganizationPermissionsService,
        {
          provide: getRepositoryToken(OrganizationPermissionEntity),
          useValue: organizationPermissionRepository,
        },
        {
          provide: getRepositoryToken(AccountPermissionEntity),
          useValue: accountPermissionRepository,
        },
        {
          provide: getRepositoryToken(AccountEntity),
          useValue: accountRepository,
        },
        { provide: getDataSourceToken(), useValue: dataSource },
        { provide: RolesService, useValue: rolesService },
      ],
    }).compile();

    service = module.get<OrganizationPermissionsService>(
      OrganizationPermissionsService,
    );
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('assertHasOrganizationPermission', () => {
    it('pasa si el llamador es miembro activo con rol ADMIN de esa organización', async () => {
      accountRepository.findOne.mockResolvedValue(adminMembership());

      await expect(
        service.assertHasOrganizationPermission(
          'owner-1',
          'org-1',
          ACTION_KEY_ENUM.READ,
        ),
      ).resolves.toBeUndefined();
      expect(accountRepository.findOne).toHaveBeenCalledWith({
        where: { userId: 'owner-1', organizationId: 'org-1', isActive: true },
        relations: { role: true },
      });
    });

    /** Sin membresía no hay roleId, y sin roleId `assertHasPermission` niega todo. */
    it('lanza ForbiddenException si no hay membresía activa del llamador', async () => {
      accountRepository.findOne.mockResolvedValue(null);

      await expect(
        service.assertHasOrganizationPermission(
          'intruder',
          'org-1',
          ACTION_KEY_ENUM.READ,
        ),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe('findPermissionOrFail', () => {
    it('exige que el permiso pertenezca a esa organización en la propia consulta', async () => {
      organizationPermissionRepository.findOne.mockResolvedValue({
        id: 'perm-1',
      });

      await service.findPermissionOrFail('org-1', 'perm-1');

      expect(organizationPermissionRepository.findOne).toHaveBeenCalledWith({
        where: { id: 'perm-1', organizationId: 'org-1' },
      });
    });

    it('lanza NotFoundException si no existe en esa organización', async () => {
      organizationPermissionRepository.findOne.mockResolvedValue(null);

      await expect(
        service.findPermissionOrFail('org-1', 'perm-ajeno'),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('findMemberOrFail', () => {
    it('devuelve la membresía de organización', async () => {
      const member = { id: 'member-1', organizationId: 'org-1' };
      accountRepository.findOne.mockResolvedValue(member);

      expect(await service.findMemberOrFail('member-1')).toBe(member);
    });

    /** Una cuenta personal no tiene permisos de organización que asignar. */
    it('trata una cuenta sin organizationId como inexistente', async () => {
      accountRepository.findOne.mockResolvedValue({
        id: 'account-1',
        organizationId: null,
      });

      await expect(service.findMemberOrFail('account-1')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('assertPermissionsBelongToOrganization', () => {
    it('no consulta nada si la lista viene vacía', async () => {
      await service.assertPermissionsBelongToOrganization([], 'org-1');

      expect(organizationPermissionRepository.find).not.toHaveBeenCalled();
    });

    it('lanza BadRequestException si algún id no está en el catálogo de la organización', async () => {
      organizationPermissionRepository.find.mockResolvedValue([
        { id: 'perm-1' },
      ]);

      await expect(
        service.assertPermissionsBelongToOrganization(
          ['perm-1', 'perm-2'],
          'org-1',
        ),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('assertNameNotTaken', () => {
    it('lanza ConflictException si ya hay un permiso con ese nombre', async () => {
      organizationPermissionRepository.findOne.mockResolvedValue({
        id: 'perm-existing',
      });

      await expect(
        service.assertNameNotTaken('org-1', 'Aprobar'),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe('replaceMemberPermissions', () => {
    it('borra e inserta dentro de la misma transacción', async () => {
      await service.replaceMemberPermissions('member-1', ['perm-1']);

      expect(dataSource.transaction).toHaveBeenCalled();
      expect(accountPermissionRepository.delete).toHaveBeenCalledWith({
        accountId: 'member-1',
      });
      expect(accountPermissionRepository.insert).toHaveBeenCalledWith([
        { accountId: 'member-1', organizationPermissionId: 'perm-1' },
      ]);
    });

    it('con una lista vacía sólo borra', async () => {
      await service.replaceMemberPermissions('member-1', []);

      expect(accountPermissionRepository.delete).toHaveBeenCalled();
      expect(accountPermissionRepository.insert).not.toHaveBeenCalled();
    });
  });
});
