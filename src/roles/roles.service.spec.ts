import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm';
import { In } from 'typeorm';
import { RolesService } from './roles.service';
import { RoleEntity } from './entities/role.entity';
import { RolePermissionEntity } from './entities/role-permission.entity';
import { PermissionEntity } from './entities/permission.entity';
import { AccountEntity } from 'src/account/entities/account.entity';
import { RESOURCE_KEY_ENUM } from './enums/resource-key.enum';
import { ACTION_KEY_ENUM } from './enums/action-key.enum';
import { PERMISSION_SCOPE_ENUM } from './enums/permission-scope.enum';
import {
  STATIC_PERMISSION_CATALOG,
  STATIC_PERMISSION_KEY_ENUM,
} from './static-permission-catalog';

function createMockRepository() {
  return {
    find: jest.fn(),
    findOne: jest.fn(),
    create: jest.fn((data: unknown) => data),
    save: jest.fn(async (data: unknown) => data),
    insert: jest.fn(),
    delete: jest.fn(),
  };
}

describe('RolesService', () => {
  let service: RolesService;
  let roleRepository: ReturnType<typeof createMockRepository>;
  let rolePermissionRepository: ReturnType<typeof createMockRepository>;
  let permissionRepository: ReturnType<typeof createMockRepository>;
  let accountRepository: ReturnType<typeof createMockRepository>;
  let transactionalRolePermissionRepository: ReturnType<
    typeof createMockRepository
  >;
  let dataSource: { transaction: jest.Mock };

  beforeEach(async () => {
    roleRepository = createMockRepository();
    rolePermissionRepository = createMockRepository();
    permissionRepository = createMockRepository();
    accountRepository = createMockRepository();
    transactionalRolePermissionRepository = createMockRepository();
    dataSource = {
      transaction: jest.fn(async (run: (manager: unknown) => Promise<void>) =>
        run({
          getRepository: jest.fn(() => transactionalRolePermissionRepository),
        }),
      ),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RolesService,
        { provide: getRepositoryToken(RoleEntity), useValue: roleRepository },
        {
          provide: getRepositoryToken(RolePermissionEntity),
          useValue: rolePermissionRepository,
        },
        {
          provide: getRepositoryToken(PermissionEntity),
          useValue: permissionRepository,
        },
        {
          provide: getRepositoryToken(AccountEntity),
          useValue: accountRepository,
        },
        { provide: getDataSourceToken(), useValue: dataSource },
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

  describe('getPermissionScopes', () => {
    /**
     * `DOCUMENT.READ_OWN` y `DOCUMENT.READ_ORGANIZATION` comparten recurso y acción: lo único
     * que los separa es el alcance. Devolver los dos es lo que después permite a
     * `DocumentAuthorizationPolicy` decidir por cuál entra cada documento.
     */
    it('devuelve todos los alcances concedidos para ese recurso y esa acción', async () => {
      rolePermissionRepository.find.mockResolvedValue([
        { permission: { scope: PERMISSION_SCOPE_ENUM.OWN } },
        { permission: { scope: PERMISSION_SCOPE_ENUM.ORGANIZATION } },
      ]);

      const scopes = await service.getPermissionScopes(
        'admin-role-1',
        RESOURCE_KEY_ENUM.DOCUMENT,
        ACTION_KEY_ENUM.READ,
      );

      expect(scopes).toEqual([
        PERMISSION_SCOPE_ENUM.OWN,
        PERMISSION_SCOPE_ENUM.ORGANIZATION,
      ]);
    });

    /**
     * La consulta recorre `role_permissions → permissions → resources → actions` y en ningún
     * punto menciona el nombre del rol: es lo que hace que un rol custom con una combinación
     * parcial del catálogo funcione igual que ADMIN.
     */
    it('consulta el catálogo por claves de recurso y acción, nunca por el nombre del rol', async () => {
      rolePermissionRepository.find.mockResolvedValue([]);

      await service.getPermissionScopes(
        'custom-role-1',
        RESOURCE_KEY_ENUM.BILLING,
        ACTION_KEY_ENUM.MANAGE,
      );

      expect(rolePermissionRepository.find).toHaveBeenCalledWith({
        where: {
          roleId: 'custom-role-1',
          permission: {
            resource: { key: RESOURCE_KEY_ENUM.BILLING },
            action: { key: ACTION_KEY_ENUM.MANAGE },
          },
        },
        relations: { permission: { resource: true, action: true } },
      });
    });

    it('devuelve una lista vacía cuando el rol no tiene ese permiso', async () => {
      rolePermissionRepository.find.mockResolvedValue([]);

      await expect(
        service.getPermissionScopes(
          'member-role-1',
          RESOURCE_KEY_ENUM.BILLING,
          ACTION_KEY_ENUM.READ,
        ),
      ).resolves.toEqual([]);
    });

    it('no repite un alcance que llegue duplicado', async () => {
      rolePermissionRepository.find.mockResolvedValue([
        { permission: { scope: PERMISSION_SCOPE_ENUM.OWN } },
        { permission: { scope: PERMISSION_SCOPE_ENUM.OWN } },
      ]);

      await expect(
        service.getPermissionScopes(
          'admin-role-1',
          RESOURCE_KEY_ENUM.DOCUMENT,
          ACTION_KEY_ENUM.READ,
        ),
      ).resolves.toEqual([PERMISSION_SCOPE_ENUM.OWN]);
    });

    it('devuelve una lista vacía sin consultar la base si la membresía no tiene rol', async () => {
      await expect(
        service.getPermissionScopes(
          null,
          RESOURCE_KEY_ENUM.DOCUMENT,
          ACTION_KEY_ENUM.READ,
        ),
      ).resolves.toEqual([]);

      expect(rolePermissionRepository.find).not.toHaveBeenCalled();
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

  /**
   * Fila de `permissions` tal como la resolvería `resolveStaticPermissionIds` para esa clave.
   *
   * Se arma DESDE el catálogo en vez de repetir aquí sus definiciones: cuando el catálogo crece,
   * esta prueba no tiene que crecer con él (y no puede quedarse describiendo permisos que ya
   * cambiaron de recurso, acción o alcance).
   */
  function buildStaticPermissionRow(
    id: string,
    key: STATIC_PERMISSION_KEY_ENUM,
  ) {
    const { resource, action, scope } = STATIC_PERMISSION_CATALOG[key];

    return {
      id,
      scope,
      resource: { key: resource },
      action: { key: action },
    };
  }

  describe('assertHasOrganizationPermission', () => {
    it('no lanza si el llamador es un miembro activo con el permiso', async () => {
      accountRepository.findOne.mockResolvedValue({
        roleId: 'admin-role-1',
      });
      rolePermissionRepository.findOne.mockResolvedValue({ id: 'rp-1' });

      await expect(
        service.assertHasOrganizationPermission(
          'user-1',
          'org-1',
          ACTION_KEY_ENUM.READ,
        ),
      ).resolves.toBeUndefined();

      expect(accountRepository.findOne).toHaveBeenCalledWith({
        where: { userId: 'user-1', organizationId: 'org-1', isActive: true },
        relations: { role: true },
      });
    });

    it('lanza ForbiddenException si el llamador no tiene membresía activa en la organización', async () => {
      accountRepository.findOne.mockResolvedValue(null);
      rolePermissionRepository.findOne.mockResolvedValue(null);

      await expect(
        service.assertHasOrganizationPermission(
          'user-1',
          'org-1',
          ACTION_KEY_ENUM.UPDATE,
        ),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe('listOrganizationRoles', () => {
    it('trae los roles de sistema y los propios de la organización en una sola consulta', async () => {
      roleRepository.find.mockResolvedValue([]);

      await service.listOrganizationRoles('org-1');

      expect(roleRepository.find).toHaveBeenCalledWith({
        where: [{ isSystemRole: true }, { organizationId: 'org-1' }],
        order: { name: 'ASC' },
      });
    });
  });

  describe('createOrganizationRole', () => {
    it('crea el rol y sus permisos cuando el nombre está disponible', async () => {
      roleRepository.findOne.mockResolvedValue(null);
      permissionRepository.find.mockResolvedValue([
        buildStaticPermissionRow(
          'perm-approve',
          STATIC_PERMISSION_KEY_ENUM.DOCUMENT_APPROVE,
        ),
        buildStaticPermissionRow(
          'perm-read-org',
          STATIC_PERMISSION_KEY_ENUM.DOCUMENT_READ_ORGANIZATION,
        ),
      ]);
      roleRepository.save.mockResolvedValue({
        id: 'role-nuevo',
        name: 'Aprobador',
        isSystemRole: false,
        organizationId: 'org-1',
      });

      const role = await service.createOrganizationRole('org-1', 'Aprobador', [
        STATIC_PERMISSION_KEY_ENUM.DOCUMENT_READ_ORGANIZATION,
        STATIC_PERMISSION_KEY_ENUM.DOCUMENT_APPROVE,
      ]);

      expect(role.id).toBe('role-nuevo');
      expect(rolePermissionRepository.insert).toHaveBeenCalledWith([
        { roleId: 'role-nuevo', permissionId: 'perm-read-org' },
        { roleId: 'role-nuevo', permissionId: 'perm-approve' },
      ]);
    });

    it('crea el rol sin permisos si el arreglo viene vacío', async () => {
      roleRepository.findOne.mockResolvedValue(null);
      roleRepository.save.mockResolvedValue({
        id: 'role-nuevo',
        name: 'Solo lectura',
        isSystemRole: false,
        organizationId: 'org-1',
      });

      await service.createOrganizationRole('org-1', 'Solo lectura', []);

      expect(rolePermissionRepository.insert).not.toHaveBeenCalled();
    });

    it('rechaza un nombre que ya usa otro rol de la misma organización', async () => {
      roleRepository.findOne.mockResolvedValue({
        id: 'role-existente',
        name: 'Aprobador',
        organizationId: 'org-1',
      });

      await expect(
        service.createOrganizationRole('org-1', 'Aprobador', []),
      ).rejects.toThrow(ConflictException);
    });

    it.each(['ADMIN', 'MEMBER'])(
      'rechaza el nombre de rol de sistema "%s"',
      async (name) => {
        await expect(
          service.createOrganizationRole('org-1', name, []),
        ).rejects.toThrow(ConflictException);

        expect(roleRepository.findOne).not.toHaveBeenCalled();
      },
    );

    it('lanza un error claro si una clave del catálogo estático no está sembrada', async () => {
      roleRepository.findOne.mockResolvedValue(null);
      permissionRepository.find.mockResolvedValue([]);

      await expect(
        service.createOrganizationRole('org-1', 'Aprobador', [
          STATIC_PERMISSION_KEY_ENUM.DOCUMENT_APPROVE,
        ]),
      ).rejects.toThrow(/seed:static-permissions/);
    });
  });

  describe('updateOrganizationRole', () => {
    const customRole = {
      id: 'role-1',
      name: 'Aprobador',
      isSystemRole: false,
      organizationId: 'org-1',
    };

    it('renombra un rol custom propio de la organización', async () => {
      roleRepository.findOne
        .mockResolvedValueOnce({ ...customRole })
        .mockResolvedValueOnce(null);

      const result = await service.updateOrganizationRole('org-1', 'role-1', {
        name: 'Aprobador Senior',
      });

      expect(result.name).toBe('Aprobador Senior');
      expect(roleRepository.save).toHaveBeenCalled();
    });

    it('reemplaza el set completo de permisos, no lo agrega', async () => {
      roleRepository.findOne.mockResolvedValue({ ...customRole });
      permissionRepository.find.mockResolvedValue([
        buildStaticPermissionRow(
          'perm-invite',
          STATIC_PERMISSION_KEY_ENUM.MEMBER_INVITE,
        ),
      ]);

      await service.updateOrganizationRole('org-1', 'role-1', {
        permissionKeys: [STATIC_PERMISSION_KEY_ENUM.MEMBER_INVITE],
      });

      expect(dataSource.transaction).toHaveBeenCalledTimes(1);
      expect(transactionalRolePermissionRepository.delete).toHaveBeenCalledWith(
        { roleId: 'role-1' },
      );
      expect(transactionalRolePermissionRepository.insert).toHaveBeenCalledWith(
        [{ roleId: 'role-1', permissionId: 'perm-invite' }],
      );
    });

    it('rechaza editar un rol de sistema', async () => {
      roleRepository.findOne.mockResolvedValue({
        id: 'admin-role-1',
        name: 'ADMIN',
        isSystemRole: true,
        organizationId: null,
      });

      await expect(
        service.updateOrganizationRole('org-1', 'admin-role-1', {
          name: 'Otro nombre',
        }),
      ).rejects.toThrow(NotFoundException);
    });

    it('rechaza editar un rol de otra organización', async () => {
      roleRepository.findOne.mockResolvedValue({
        ...customRole,
        organizationId: 'org-2',
      });

      await expect(
        service.updateOrganizationRole('org-1', 'role-1', {
          name: 'Otro nombre',
        }),
      ).rejects.toThrow(NotFoundException);
    });

    it('rechaza un nuevo nombre que ya usa otro rol de la organización', async () => {
      roleRepository.findOne
        .mockResolvedValueOnce({ ...customRole })
        .mockResolvedValueOnce({ id: 'role-2', name: 'Otro rol' });

      await expect(
        service.updateOrganizationRole('org-1', 'role-1', {
          name: 'Otro rol',
        }),
      ).rejects.toThrow(ConflictException);
    });

    it('no valida el nombre si no cambia', async () => {
      roleRepository.findOne.mockResolvedValue({ ...customRole });

      await service.updateOrganizationRole('org-1', 'role-1', {
        name: 'Aprobador',
      });

      expect(roleRepository.save).not.toHaveBeenCalled();
    });
  });
});
