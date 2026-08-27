import { Test, TestingModule } from '@nestjs/testing';

import { RolesService } from '../roles.service';
import { RoleEntity } from '../entities/role.entity';
import { GetSystemRolesUseCase } from './get-system-roles.use-case';

describe('GetSystemRolesUseCase', () => {
  let useCase: GetSystemRolesUseCase;
  let rolesService: { listSystemRoles: jest.Mock };

  beforeEach(async () => {
    rolesService = { listSystemRoles: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GetSystemRolesUseCase,
        { provide: RolesService, useValue: rolesService },
      ],
    }).compile();

    useCase = module.get(GetSystemRolesUseCase);
  });

  it('proyecta cada rol a id/name/isSystemRole', async () => {
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

    const result = await useCase.execute();

    expect(result).toEqual({
      success: true,
      message: 'Roles del sistema obtenidos correctamente',
      data: [
        { id: 'role-1', name: 'ADMIN', isSystemRole: true },
        { id: 'role-2', name: 'MEMBER', isSystemRole: true },
      ],
    });
  });

  /**
   * `organizationId` no viaja al cliente: el catálogo es de roles de sistema y exponer columnas
   * internas del entity haría que cualquier cambio de esquema se filtrara a la API.
   */
  it('no expone columnas del entity fuera de id/name/isSystemRole', async () => {
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

    expect(Object.keys(role).sort()).toEqual(['id', 'isSystemRole', 'name']);
  });

  it('devuelve data vacía si no hay roles de sistema sembrados', async () => {
    rolesService.listSystemRoles.mockResolvedValue([]);

    expect((await useCase.execute()).data).toEqual([]);
  });
});
