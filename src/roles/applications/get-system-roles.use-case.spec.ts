import { Test, TestingModule } from '@nestjs/testing';

import { RolesService } from '../roles.service';
import { RoleEntity } from '../entities/role.entity';
import { RolePermissionData } from '../interfaces/response/permission-response';
import { GetSystemRolesUseCase } from './get-system-roles.use-case';

const DOCUMENT_CREATE: RolePermissionData = {
  id: 'permission-1',
  key: 'DOCUMENT.CREATE',
  resource: 'DOCUMENT',
  action: 'CREATE',
  scope: 'ANY',
  description: 'Crear documentos o borradores dentro de la organización activa.',
  isStaticCatalog: true,
};

const DOCUMENT_SIGN_SELF: RolePermissionData = {
  id: 'permission-2',
  key: 'DOCUMENT.SIGN_SELF',
  resource: 'DOCUMENT',
  action: 'SIGN',
  scope: 'SELF',
  description: 'Firmar en nombre propio e incluirse como firmante.',
  isStaticCatalog: true,
};

describe('GetSystemRolesUseCase', () => {
  let useCase: GetSystemRolesUseCase;
  let rolesService: {
    listSystemRoles: jest.Mock;
    listPermissionsByRoleIds: jest.Mock;
  };

  beforeEach(async () => {
    rolesService = {
      listSystemRoles: jest.fn(),
      listPermissionsByRoleIds: jest.fn().mockResolvedValue(new Map()),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GetSystemRolesUseCase,
        { provide: RolesService, useValue: rolesService },
      ],
    }).compile();

    useCase = module.get(GetSystemRolesUseCase);
  });

  it('proyecta cada rol a id/name/isSystemRole con sus permisos', async () => {
    rolesService.listSystemRoles.mockResolvedValue([
      {
        id: 'role-1',
        name: 'ADMIN',
        isSystemRole: true,
        organizationId: null,
      },
      {
        id: 'role-2',
        name: 'MEMBER',
        isSystemRole: true,
        organizationId: null,
      },
    ] as unknown as RoleEntity[]);
    rolesService.listPermissionsByRoleIds.mockResolvedValue(
      new Map([
        ['role-1', [DOCUMENT_CREATE, DOCUMENT_SIGN_SELF]],
        ['role-2', [DOCUMENT_CREATE]],
      ]),
    );

    const result = await useCase.execute();

    expect(rolesService.listPermissionsByRoleIds).toHaveBeenCalledWith([
      'role-1',
      'role-2',
    ]);
    expect(result).toEqual({
      success: true,
      message: 'Roles del sistema obtenidos correctamente',
      data: [
        {
          id: 'role-1',
          name: 'ADMIN',
          isSystemRole: true,
          permissions: [DOCUMENT_CREATE, DOCUMENT_SIGN_SELF],
        },
        {
          id: 'role-2',
          name: 'MEMBER',
          isSystemRole: true,
          permissions: [DOCUMENT_CREATE],
        },
      ],
    });
  });

  /**
   * Un rol sin ninguna fila en `role_permissions` no aparece en el mapa que devuelve el servicio.
   * La pantalla de miembros pinta esa lista directamente, así que tiene que llegar vacía y no
   * `undefined` — si no, el selector de roles reventaría justo con el rol peor configurado.
   */
  it('devuelve permisos vacíos para un rol sin asignaciones', async () => {
    rolesService.listSystemRoles.mockResolvedValue([
      { id: 'role-1', name: 'ADMIN', isSystemRole: true },
    ] as unknown as RoleEntity[]);
    rolesService.listPermissionsByRoleIds.mockResolvedValue(new Map());

    const [role] = (await useCase.execute()).data;

    expect(role.permissions).toEqual([]);
  });

  /**
   * `organizationId` no viaja al cliente: el catálogo es de roles de sistema y exponer columnas
   * internas del entity haría que cualquier cambio de esquema se filtrara a la API.
   */
  it('no expone columnas del entity fuera de id/name/isSystemRole/permissions', async () => {
    rolesService.listSystemRoles.mockResolvedValue([
      {
        id: 'role-1',
        name: 'ADMIN',
        isSystemRole: true,
        organizationId: 'org-1',
        createdAt: new Date(),
      },
    ] as unknown as RoleEntity[]);

    const [role] = (await useCase.execute()).data;

    expect(Object.keys(role).sort()).toEqual([
      'id',
      'isSystemRole',
      'name',
      'permissions',
    ]);
  });

  it('devuelve data vacía si no hay roles de sistema sembrados', async () => {
    rolesService.listSystemRoles.mockResolvedValue([]);

    expect((await useCase.execute()).data).toEqual([]);
  });
});
