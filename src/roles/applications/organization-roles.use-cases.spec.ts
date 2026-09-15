import { Test, TestingModule } from '@nestjs/testing';
import { getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm';
import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';

import { RolesService } from '../roles.service';
import { RoleEntity } from '../entities/role.entity';
import { RolePermissionEntity } from '../entities/role-permission.entity';
import { PermissionEntity } from '../entities/permission.entity';
import { AccountEntity } from 'src/account/entities/account.entity';
import { STATIC_PERMISSION_KEY_ENUM } from '../static-permission-catalog';

import { ListOrganizationRolesUseCase } from './list-organization-roles.use-case';
import { CreateOrganizationRoleUseCase } from './create-organization-role.use-case';
import { UpdateOrganizationRoleUseCase } from './update-organization-role.use-case';

const ADMIN_ROLE_ID = 'admin-role-1';
const MEMBER_ROLE_ID = 'member-role-1';

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

function adminMembership() {
  return {
    userId: 'admin-user-1',
    organizationId: 'org-1',
    isActive: true,
    roleId: ADMIN_ROLE_ID,
  };
}

function memberMembership() {
  return {
    userId: 'member-user-1',
    organizationId: 'org-1',
    isActive: true,
    roleId: MEMBER_ROLE_ID,
  };
}

/**
 * Casos de uso montados sobre el `RolesService` de verdad —con los repositorios simulados— para
 * cuidar la composición real: que la comprobación de ADMIN ocurra antes de tocar cualquier rol.
 */
describe('casos de uso de roles de organización', () => {
  let roleRepository: ReturnType<typeof createMockRepository>;
  let rolePermissionRepository: ReturnType<typeof createMockRepository>;
  let permissionRepository: ReturnType<typeof createMockRepository>;
  let accountRepository: ReturnType<typeof createMockRepository>;
  let dataSource: { transaction: jest.Mock };

  let listOrganizationRoles: ListOrganizationRolesUseCase;
  let createOrganizationRole: CreateOrganizationRoleUseCase;
  let updateOrganizationRole: UpdateOrganizationRoleUseCase;

  beforeEach(async () => {
    roleRepository = createMockRepository();
    rolePermissionRepository = createMockRepository();
    permissionRepository = createMockRepository();
    accountRepository = createMockRepository();
    dataSource = {
      transaction: jest.fn(async (run: (manager: unknown) => Promise<void>) =>
        run({ getRepository: jest.fn(() => rolePermissionRepository) }),
      ),
    };

    // role_permissions de los roles de sistema: ADMIN con permiso ORGANIZATION en cualquier
    // acción (mismo criterio que sembró seed-roles.ts), MEMBER sin ninguno.
    rolePermissionRepository.findOne.mockImplementation(
      async ({ where }: { where: { roleId: string } }) =>
        where.roleId === ADMIN_ROLE_ID ? { id: 'rp-org' } : null,
    );

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RolesService,
        ListOrganizationRolesUseCase,
        CreateOrganizationRoleUseCase,
        UpdateOrganizationRoleUseCase,
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

    listOrganizationRoles = module.get(ListOrganizationRolesUseCase);
    createOrganizationRole = module.get(CreateOrganizationRoleUseCase);
    updateOrganizationRole = module.get(UpdateOrganizationRoleUseCase);
  });

  describe('ListOrganizationRolesUseCase', () => {
    it('devuelve los roles de la organización para un caller ADMIN', async () => {
      accountRepository.findOne.mockResolvedValue(adminMembership());
      roleRepository.find.mockResolvedValue([
        {
          id: 'role-1',
          name: 'ADMIN',
          isSystemRole: true,
          createdAt: new Date(),
        },
      ]);
      rolePermissionRepository.find.mockResolvedValue([]);

      const response = await listOrganizationRoles.execute(
        'admin-user-1',
        'org-1',
      );

      expect(response.success).toBe(true);
      expect(response.data).toHaveLength(1);
    });

    it('rechaza a un caller MEMBER', async () => {
      accountRepository.findOne.mockResolvedValue(memberMembership());

      await expect(
        listOrganizationRoles.execute('member-user-1', 'org-1'),
      ).rejects.toThrow(ForbiddenException);

      expect(roleRepository.find).not.toHaveBeenCalled();
    });
  });

  describe('CreateOrganizationRoleUseCase', () => {
    it('un ADMIN puede crear el rol "Aprobador" con DOCUMENT.READ_ORGANIZATION y DOCUMENT.APPROVE', async () => {
      accountRepository.findOne.mockResolvedValue(adminMembership());
      roleRepository.findOne.mockResolvedValue(null);
      permissionRepository.find.mockResolvedValue([
        {
          id: 'perm-read-org',
          scope: 'ORGANIZATION',
          resource: { key: 'DOCUMENT' },
          action: { key: 'READ' },
        },
        {
          id: 'perm-approve',
          scope: 'ANY',
          resource: { key: 'DOCUMENT' },
          action: { key: 'APPROVE' },
        },
      ]);
      roleRepository.save.mockResolvedValue({
        id: 'role-aprobador',
        name: 'Aprobador',
        isSystemRole: false,
        organizationId: 'org-1',
        createdAt: new Date(),
      });
      rolePermissionRepository.find.mockResolvedValue([]);

      const response = await createOrganizationRole.execute(
        'admin-user-1',
        'org-1',
        {
          name: 'Aprobador',
          permissionKeys: [
            STATIC_PERMISSION_KEY_ENUM.DOCUMENT_READ_ORGANIZATION,
            STATIC_PERMISSION_KEY_ENUM.DOCUMENT_APPROVE,
          ],
        },
      );

      expect(response.success).toBe(true);
      expect(response.data.name).toBe('Aprobador');
      expect(rolePermissionRepository.insert).toHaveBeenCalledWith([
        { roleId: 'role-aprobador', permissionId: 'perm-read-org' },
        { roleId: 'role-aprobador', permissionId: 'perm-approve' },
      ]);
    });

    it('rechaza a un caller MEMBER sin llegar a crear nada', async () => {
      accountRepository.findOne.mockResolvedValue(memberMembership());

      await expect(
        createOrganizationRole.execute('member-user-1', 'org-1', {
          name: 'Aprobador',
          permissionKeys: [],
        }),
      ).rejects.toThrow(ForbiddenException);

      expect(roleRepository.findOne).not.toHaveBeenCalled();
      expect(roleRepository.save).not.toHaveBeenCalled();
    });
  });

  describe('UpdateOrganizationRoleUseCase', () => {
    it('otro ADMIN de la misma organización puede editar los permisos del rol', async () => {
      accountRepository.findOne.mockResolvedValue(adminMembership());
      roleRepository.findOne.mockResolvedValue({
        id: 'role-aprobador',
        name: 'Aprobador',
        isSystemRole: false,
        organizationId: 'org-1',
        createdAt: new Date(),
      });
      permissionRepository.find.mockResolvedValue([
        {
          id: 'perm-invite',
          scope: 'ANY',
          resource: { key: 'MEMBER' },
          action: { key: 'INVITE' },
        },
      ]);
      rolePermissionRepository.find.mockResolvedValue([]);

      const response = await updateOrganizationRole.execute(
        'admin-user-1',
        'org-1',
        'role-aprobador',
        { permissionKeys: [STATIC_PERMISSION_KEY_ENUM.MEMBER_INVITE] },
      );

      expect(response.success).toBe(true);
      expect(dataSource.transaction).toHaveBeenCalledTimes(1);
    });

    it('rechaza editar el rol de sistema ADMIN', async () => {
      accountRepository.findOne.mockResolvedValue(adminMembership());
      roleRepository.findOne.mockResolvedValue({
        id: ADMIN_ROLE_ID,
        name: 'ADMIN',
        isSystemRole: true,
        organizationId: null,
      });

      await expect(
        updateOrganizationRole.execute('admin-user-1', 'org-1', ADMIN_ROLE_ID, {
          name: 'Otro nombre',
        }),
      ).rejects.toThrow(NotFoundException);
    });

    it('rechaza a un caller MEMBER, incluso llamando al endpoint directo', async () => {
      accountRepository.findOne.mockResolvedValue(memberMembership());

      await expect(
        updateOrganizationRole.execute(
          'member-user-1',
          'org-1',
          'role-aprobador',
          { name: 'Otro nombre' },
        ),
      ).rejects.toThrow(ForbiddenException);

      expect(roleRepository.findOne).not.toHaveBeenCalled();
    });

    it('rechaza un nombre repetido dentro de la misma organización', async () => {
      accountRepository.findOne.mockResolvedValue(adminMembership());
      roleRepository.findOne
        .mockResolvedValueOnce({
          id: 'role-aprobador',
          name: 'Aprobador',
          isSystemRole: false,
          organizationId: 'org-1',
        })
        .mockResolvedValueOnce({ id: 'role-otro', name: 'Revisor' });

      await expect(
        updateOrganizationRole.execute(
          'admin-user-1',
          'org-1',
          'role-aprobador',
          { name: 'Revisor' },
        ),
      ).rejects.toThrow(ConflictException);
    });
  });
});
