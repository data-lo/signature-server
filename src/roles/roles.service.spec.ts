import { ForbiddenException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
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

  it('findAllSystemRoles consulta solo roles con isSystemRole=true y mapea id/name/isSystemRole', async () => {
    roleRepository.find.mockResolvedValue([
      { id: 'role-1', name: 'ADMIN', isSystemRole: true, organizationId: null },
      {
        id: 'role-2',
        name: 'MEMBER',
        isSystemRole: true,
        organizationId: null,
      },
    ]);

    const result = await service.findAllSystemRoles();

    expect(roleRepository.find).toHaveBeenCalledWith({
      where: { isSystemRole: true },
      order: { name: 'ASC' },
    });
    expect(result).toEqual({
      success: true,
      message: 'Roles del sistema obtenidos correctamente',
      data: [
        { id: 'role-1', name: 'ADMIN', isSystemRole: true },
        { id: 'role-2', name: 'MEMBER', isSystemRole: true },
      ],
    });
  });

  it('findAllSystemRoles retorna data vacía si no hay roles del sistema', async () => {
    roleRepository.find.mockResolvedValue([]);

    const result = await service.findAllSystemRoles();

    expect(result.data).toEqual([]);
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
});
