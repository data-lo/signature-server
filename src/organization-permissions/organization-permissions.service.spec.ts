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

  describe('findAllForOrganization', () => {
    it('retorna el catálogo si el llamador es ADMIN activo de la organización', async () => {
      accountRepository.findOne.mockResolvedValue(adminMembership());
      organizationPermissionRepository.find.mockResolvedValue([
        {
          id: 'perm-1',
          organizationId: 'org-1',
          name: 'Aprobar',
          isActive: true,
        },
      ]);

      const result = await service.findAllForOrganization('owner-1', 'org-1');

      expect(result.data).toHaveLength(1);
    });

    it('lanza ForbiddenException si el llamador no es ADMIN activo de la organización', async () => {
      accountRepository.findOne.mockResolvedValue(null);

      await expect(
        service.findAllForOrganization('intruder', 'org-1'),
      ).rejects.toThrow(ForbiddenException);
      expect(organizationPermissionRepository.find).not.toHaveBeenCalled();
    });
  });

  describe('create', () => {
    it('crea el permiso si el llamador es ADMIN activo de la organización', async () => {
      accountRepository.findOne.mockResolvedValue(adminMembership());

      const result = await service.create('owner-1', 'org-1', {
        name: 'Aprobar documentos',
      });

      expect(organizationPermissionRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          organizationId: 'org-1',
          name: 'Aprobar documentos',
        }),
      );
      expect(result.success).toBe(true);
    });

    it('lanza ForbiddenException si el llamador no es ADMIN activo de la organización', async () => {
      accountRepository.findOne.mockResolvedValue(null);

      await expect(
        service.create('intruder', 'org-1', { name: 'Aprobar' }),
      ).rejects.toThrow(ForbiddenException);
      expect(organizationPermissionRepository.save).not.toHaveBeenCalled();
    });

    it('lanza ConflictException si ya existe un permiso con ese nombre en la organización', async () => {
      accountRepository.findOne.mockResolvedValue(adminMembership());
      organizationPermissionRepository.findOne.mockResolvedValue({
        id: 'perm-existing',
        organizationId: 'org-1',
        name: 'Aprobar documentos',
      });

      await expect(
        service.create('owner-1', 'org-1', { name: 'Aprobar documentos' }),
      ).rejects.toThrow(ConflictException);
      expect(organizationPermissionRepository.save).not.toHaveBeenCalled();
    });
  });

  describe('update', () => {
    it('lanza NotFoundException si el permiso no existe en esa organización', async () => {
      accountRepository.findOne.mockResolvedValue(adminMembership());
      organizationPermissionRepository.findOne.mockResolvedValue(null);

      await expect(
        service.update('owner-1', 'org-1', 'missing-perm', { isActive: false }),
      ).rejects.toThrow(NotFoundException);
      expect(organizationPermissionRepository.update).not.toHaveBeenCalled();
    });

    it('actualiza nombre y/o estatus cuando el permiso existe', async () => {
      accountRepository.findOne.mockResolvedValue(adminMembership());
      organizationPermissionRepository.findOne.mockResolvedValue({
        id: 'perm-1',
        organizationId: 'org-1',
        name: 'Aprobar',
        isActive: true,
      });

      await service.update('owner-1', 'org-1', 'perm-1', { isActive: false });

      expect(organizationPermissionRepository.update).toHaveBeenCalledWith(
        'perm-1',
        { isActive: false },
      );
    });

    it('permite guardar sin cambiar el nombre, sin disparar el chequeo de duplicados', async () => {
      accountRepository.findOne.mockResolvedValue(adminMembership());
      organizationPermissionRepository.findOne.mockResolvedValue({
        id: 'perm-1',
        organizationId: 'org-1',
        name: 'Aprobar',
        isActive: true,
      });

      await service.update('owner-1', 'org-1', 'perm-1', {
        name: 'Aprobar',
        isActive: false,
      });

      // Solo se llama findOne para findPermissionOrFail (x2, antes y después del update) —
      // el chequeo de duplicados no debe ejecutar una consulta extra si el nombre no cambió.
      expect(organizationPermissionRepository.findOne).toHaveBeenCalledTimes(2);
      expect(organizationPermissionRepository.update).toHaveBeenCalledWith(
        'perm-1',
        { name: 'Aprobar', isActive: false },
      );
    });

    it('lanza ConflictException al renombrar a un nombre ya usado por otro permiso de la organización', async () => {
      accountRepository.findOne.mockResolvedValue(adminMembership());
      organizationPermissionRepository.findOne
        .mockResolvedValueOnce({
          id: 'perm-1',
          organizationId: 'org-1',
          name: 'Aprobar',
          isActive: true,
        }) // findPermissionOrFail
        .mockResolvedValueOnce({
          id: 'perm-2',
          organizationId: 'org-1',
          name: 'Ver reportes',
        }); // assertNameNotTaken: ya existe otro permiso con ese nombre

      await expect(
        service.update('owner-1', 'org-1', 'perm-1', { name: 'Ver reportes' }),
      ).rejects.toThrow(ConflictException);
      expect(organizationPermissionRepository.update).not.toHaveBeenCalled();
    });
  });

  describe('remove', () => {
    it('lanza NotFoundException si el permiso no existe en esa organización', async () => {
      accountRepository.findOne.mockResolvedValue(adminMembership());
      organizationPermissionRepository.findOne.mockResolvedValue(null);

      await expect(
        service.remove('owner-1', 'org-1', 'missing-perm'),
      ).rejects.toThrow(NotFoundException);
      expect(organizationPermissionRepository.delete).not.toHaveBeenCalled();
    });

    it('elimina el permiso cuando existe (la cascada limpia sus asignaciones)', async () => {
      accountRepository.findOne.mockResolvedValue(adminMembership());
      organizationPermissionRepository.findOne.mockResolvedValue({
        id: 'perm-1',
        organizationId: 'org-1',
      });

      const result = await service.remove('owner-1', 'org-1', 'perm-1');

      expect(organizationPermissionRepository.delete).toHaveBeenCalledWith(
        'perm-1',
      );
      expect(result.success).toBe(true);
    });
  });

  describe('findMemberPermissions', () => {
    it('retorna los IDs de permisos actualmente asignados al miembro', async () => {
      accountRepository.findOne
        .mockResolvedValueOnce({ id: 'member-1', organizationId: 'org-1' }) // findMemberOrFail
        .mockResolvedValueOnce(adminMembership()); // ownership check del llamador
      accountPermissionRepository.find.mockResolvedValue([
        { organizationPermissionId: 'perm-1' },
        { organizationPermissionId: 'perm-2' },
      ]);

      const result = await service.findMemberPermissions('owner-1', 'member-1');

      expect(result.data).toEqual({
        accountId: 'member-1',
        permissionIds: ['perm-1', 'perm-2'],
      });
    });

    it('lanza NotFoundException si la membresía no existe', async () => {
      accountRepository.findOne.mockResolvedValue(null);

      await expect(
        service.findMemberPermissions('owner-1', 'missing-member'),
      ).rejects.toThrow(NotFoundException);
    });

    it('lanza ForbiddenException si el llamador no es ADMIN de esa organización', async () => {
      accountRepository.findOne
        .mockResolvedValueOnce({ id: 'member-1', organizationId: 'org-1' })
        .mockResolvedValueOnce(null);

      await expect(
        service.findMemberPermissions('intruder', 'member-1'),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe('assignToMember', () => {
    it('lanza BadRequestException si algún permiso no pertenece al catálogo de la organización', async () => {
      accountRepository.findOne
        .mockResolvedValueOnce({ id: 'member-1', organizationId: 'org-1' })
        .mockResolvedValueOnce(adminMembership());
      organizationPermissionRepository.find.mockResolvedValue([
        { id: 'perm-1' },
      ]); // solo uno de los dos IDs solicitados existe

      await expect(
        service.assignToMember('owner-1', 'member-1', ['perm-1', 'perm-2']),
      ).rejects.toThrow(BadRequestException);
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });

    it('reemplaza las asignaciones dentro de una transacción cuando los permisos son válidos', async () => {
      accountRepository.findOne
        .mockResolvedValueOnce({ id: 'member-1', organizationId: 'org-1' })
        .mockResolvedValueOnce(adminMembership());
      organizationPermissionRepository.find.mockResolvedValue([
        { id: 'perm-1' },
        { id: 'perm-2' },
      ]);

      const result = await service.assignToMember('owner-1', 'member-1', [
        'perm-1',
        'perm-2',
      ]);

      expect(dataSource.transaction).toHaveBeenCalled();
      expect(accountPermissionRepository.delete).toHaveBeenCalledWith({
        accountId: 'member-1',
      });
      expect(accountPermissionRepository.insert).toHaveBeenCalledWith([
        { accountId: 'member-1', organizationPermissionId: 'perm-1' },
        { accountId: 'member-1', organizationPermissionId: 'perm-2' },
      ]);
      expect(result.data.permissionIds).toEqual(['perm-1', 'perm-2']);
    });

    it('permite desasignar todo con un arreglo vacío, sin insertar nada', async () => {
      accountRepository.findOne
        .mockResolvedValueOnce({ id: 'member-1', organizationId: 'org-1' })
        .mockResolvedValueOnce(adminMembership());

      await service.assignToMember('owner-1', 'member-1', []);

      expect(organizationPermissionRepository.find).not.toHaveBeenCalled();
      expect(accountPermissionRepository.delete).toHaveBeenCalledWith({
        accountId: 'member-1',
      });
      expect(accountPermissionRepository.insert).not.toHaveBeenCalled();
    });

    it('lanza ForbiddenException si el llamador no es ADMIN de esa organización', async () => {
      accountRepository.findOne
        .mockResolvedValueOnce({ id: 'member-1', organizationId: 'org-1' })
        .mockResolvedValueOnce(null);

      await expect(
        service.assignToMember('intruder', 'member-1', []),
      ).rejects.toThrow(ForbiddenException);
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });
  });
});
