import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { In } from 'typeorm';
import { RolesService } from './roles.service';
import { RoleEntity } from './entities/role.entity';
import { RolePermissionEntity } from './entities/role-permission.entity';
import { RESOURCE_KEY_ENUM } from './enums/resource-key.enum';
import { ACTION_KEY_ENUM } from './enums/action-key.enum';

function createMockRepository() {
  return {
    find: jest.fn(),
    findOne: jest.fn(),
  };
}

describe('RolesService', () => {
  let service: RolesService;
  let roleRepository: ReturnType<typeof createMockRepository>;
  let rolePermissionRepository: ReturnType<typeof createMockRepository>;

  beforeEach(async () => {
    roleRepository = createMockRepository();
    rolePermissionRepository = createMockRepository();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RolesService,
        { provide: getRepositoryToken(RoleEntity), useValue: roleRepository },
        {
          provide: getRepositoryToken(RolePermissionEntity),
          useValue: rolePermissionRepository,
        },
      ],
    }).compile();

    service = module.get<RolesService>(RolesService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('listSystemRoles consulta solo roles con isSystemRole=true, ordenados por nombre', async () => {
    const roles = [
      { id: 'role-1', name: 'ADMIN', isSystemRole: true, organizationId: null },
      {
        id: 'role-2',
        name: 'MEMBER',
        isSystemRole: true,
        organizationId: null,
      },
    ];
    roleRepository.find.mockResolvedValue(roles);

    const result = await service.listSystemRoles();

    expect(roleRepository.find).toHaveBeenCalledWith({
      where: { isSystemRole: true },
      order: { name: 'ASC' },
    });
    expect(result).toBe(roles);
  });

  describe('hasPermission', () => {
    it('retorna true si existe una fila role_permissions para ese roleId+resource+action', async () => {
      rolePermissionRepository.findOne.mockResolvedValue({
        id: 'rp-1',
        roleId: 'admin-role-1',
      });

      const result = await service.hasPermission(
        'admin-role-1',
        RESOURCE_KEY_ENUM.ORGANIZATION,
        ACTION_KEY_ENUM.DELETE,
      );

      expect(result).toBe(true);
      expect(rolePermissionRepository.findOne).toHaveBeenCalledWith({
        where: {
          roleId: 'admin-role-1',
          permission: {
            resource: { key: RESOURCE_KEY_ENUM.ORGANIZATION },
            action: { key: ACTION_KEY_ENUM.DELETE },
          },
        },
        relations: { permission: { resource: true, action: true } },
      });
    });

    it('retorna false si no existe esa combinación de permiso para el rol', async () => {
      rolePermissionRepository.findOne.mockResolvedValue(null);

      const result = await service.hasPermission(
        'member-role-1',
        RESOURCE_KEY_ENUM.ORGANIZATION,
        ACTION_KEY_ENUM.DELETE,
      );

      expect(result).toBe(false);
    });

    it('retorna false sin consultar la base si roleId es null/undefined', async () => {
      const result = await service.hasPermission(
        null,
        RESOURCE_KEY_ENUM.DOCUMENT,
        ACTION_KEY_ENUM.READ,
      );

      expect(result).toBe(false);
      expect(rolePermissionRepository.findOne).not.toHaveBeenCalled();
    });
  });

  describe('assertHasPermission', () => {
    it('no lanza si el rol tiene el permiso', async () => {
      rolePermissionRepository.findOne.mockResolvedValue({ id: 'rp-1' });

      await expect(
        service.assertHasPermission(
          'admin-role-1',
          RESOURCE_KEY_ENUM.DOCUMENT,
          ACTION_KEY_ENUM.CREATE,
        ),
      ).resolves.toBeUndefined();
    });

    it('lanza ForbiddenException con el mensaje dado si el rol no tiene el permiso', async () => {
      rolePermissionRepository.findOne.mockResolvedValue(null);

      await expect(
        service.assertHasPermission(
          'member-role-1',
          RESOURCE_KEY_ENUM.ORGANIZATION,
          ACTION_KEY_ENUM.DELETE,
          'No tienes permisos de administrador sobre esta organización',
        ),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  /**
   * Un rol asignable es uno del sistema o uno de la propia organización. Es la regla que impide
   * que conocer el UUID de un rol custom ajeno alcance para llevarse sus permisos a otro tenant.
   */
  describe('findAssignableRoleOrFail', () => {
    it('acepta un rol del sistema', async () => {
      const systemRole = {
        id: 'admin-role-1',
        name: 'ADMIN',
        isSystemRole: true,
        organizationId: null,
      };
      roleRepository.findOne.mockResolvedValue(systemRole);

      await expect(
        service.findAssignableRoleOrFail('admin-role-1', 'org-1'),
      ).resolves.toEqual(systemRole);
    });

    it('acepta un rol custom de la misma organización', async () => {
      const customRole = {
        id: 'auditor-role',
        name: 'AUDITOR',
        isSystemRole: false,
        organizationId: 'org-1',
      };
      roleRepository.findOne.mockResolvedValue(customRole);

      await expect(
        service.findAssignableRoleOrFail('auditor-role', 'org-1'),
      ).resolves.toEqual(customRole);
    });

    it('trata como inexistente un rol custom de otra organización', async () => {
      roleRepository.findOne.mockResolvedValue({
        id: 'auditor-role',
        name: 'AUDITOR',
        isSystemRole: false,
        organizationId: 'org-2',
      });

      await expect(
        service.findAssignableRoleOrFail('auditor-role', 'org-1'),
      ).rejects.toThrow(NotFoundException);
    });

    it('lanza NotFoundException si el rol no existe', async () => {
      roleRepository.findOne.mockResolvedValue(null);

      await expect(
        service.findAssignableRoleOrFail('desconocido', 'org-1'),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('listPermissionsByRoleIds', () => {
    const documentResource = {
      id: 'resource-1',
      key: 'DOCUMENT',
      description: 'Documentos para firma electrónica',
    };
    const createAction = {
      id: 'action-1',
      key: 'CREATE',
      description: 'Crear un recurso nuevo',
    };
    const readAction = {
      id: 'action-2',
      key: 'READ',
      description: 'Consultar un recurso existente',
    };

    it('agrupa por rol y ordena el catálogo estático primero', async () => {
      rolePermissionRepository.find.mockResolvedValue([
        {
          roleId: 'member-role-1',
          permission: {
            id: 'permission-read-own',
            scope: 'OWN',
            resource: documentResource,
            action: readAction,
          },
        },
        {
          roleId: 'member-role-1',
          permission: {
            id: 'permission-create',
            scope: 'ANY',
            resource: documentResource,
            action: createAction,
          },
        },
        {
          roleId: 'admin-role-1',
          permission: {
            id: 'permission-create',
            scope: 'ANY',
            resource: documentResource,
            action: createAction,
          },
        },
      ]);

      const grouped = await service.listPermissionsByRoleIds([
        'member-role-1',
        'admin-role-1',
      ]);

      expect(grouped.get('member-role-1')?.map((one) => one.key)).toEqual([
        'DOCUMENT.CREATE',
        'DOCUMENT.READ_OWN',
      ]);
      expect(grouped.get('admin-role-1')?.map((one) => one.key)).toEqual([
        'DOCUMENT.CREATE',
      ]);
    });

    it('consulta una sola vez aunque el mismo rol se repita', async () => {
      rolePermissionRepository.find.mockResolvedValue([]);

      await service.listPermissionsByRoleIds([
        'member-role-1',
        'member-role-1',
        'admin-role-1',
      ]);

      expect(rolePermissionRepository.find).toHaveBeenCalledTimes(1);
      expect(rolePermissionRepository.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { roleId: In(['member-role-1', 'admin-role-1']) },
        }),
      );
    });

    /** `In([])` genera SQL inválido; sin la guarda, una organización sin roles tumbaría la tabla. */
    it('no consulta la base si no hay roles que resolver', async () => {
      const grouped = await service.listPermissionsByRoleIds([]);

      expect(grouped.size).toBe(0);
      expect(rolePermissionRepository.find).not.toHaveBeenCalled();
    });
  });
});
