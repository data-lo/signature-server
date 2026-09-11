import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { AccountMemberService } from '../account-member.service';
import { AccountEntity } from '../entities/account.entity';
import { UserEntity } from 'src/user/entities/user.entity';
import { AccountService } from '../account.service';
import { RolesService } from 'src/roles/roles.service';
import { SYSTEM_ROLE_NAME_ENUM } from 'src/roles/enums/system-role-name.enum';
import { ACCOUNT_TYPE_ENUM } from '../enums/account-type.enum';
import { ACCOUNT_STATUS_ENUM } from '../enums/account-status.enum';
import { RolePermissionData } from 'src/roles/interfaces/response/permission-response';

import { AddOrganizationMemberUseCase } from './add-organization-member.use-case';
import { GrantAccountAccessUseCase } from './grant-account-access.use-case';
import { GetOrganizationMembersUseCase } from './get-organization-members.use-case';
import { GetOrganizationMemberListUseCase } from './get-organization-member-list.use-case';
import { GetAccountMemberUseCase } from './get-account-member.use-case';
import { UpdateAccountMemberUseCase } from './update-account-member.use-case';
import { RevokeAccountAccessUseCase } from './revoke-account-access.use-case';

const ADMIN_ROLE = { id: 'admin-role-1', name: SYSTEM_ROLE_NAME_ENUM.ADMIN };
const MEMBER_ROLE = { id: 'member-role-1', name: SYSTEM_ROLE_NAME_ENUM.MEMBER };

/** Los tres permisos que el catálogo estático le da a MEMBER, tal como los publica la API. */
const MEMBER_PERMISSIONS: RolePermissionData[] = [
  {
    id: 'permission-create',
    key: 'DOCUMENT.CREATE',
    resource: 'DOCUMENT',
    action: 'CREATE',
    scope: 'ANY',
    description:
      'Crear documentos o borradores dentro de la organización activa.',
    isStaticCatalog: true,
  },
  {
    id: 'permission-read-own',
    key: 'DOCUMENT.READ_OWN',
    resource: 'DOCUMENT',
    action: 'READ',
    scope: 'OWN',
    description:
      'Consultar documentos propios o donde el miembro sea firmante.',
    isStaticCatalog: true,
  },
  {
    id: 'permission-sign-self',
    key: 'DOCUMENT.SIGN_SELF',
    resource: 'DOCUMENT',
    action: 'SIGN',
    scope: 'SELF',
    description: 'Firmar en nombre propio e incluirse como firmante.',
    isStaticCatalog: true,
  },
];

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

/**
 * Los casos de uso se montan sobre el `AccountMemberService` real con repositorios simulados:
 * lo que importa acá es la secuencia —comprobar permisos, proteger al último administrador,
 * escribir— y con el servicio simulado no quedaría nada de eso bajo prueba.
 */
describe('casos de uso de miembros de organización', () => {
  let addOrganizationMember: AddOrganizationMemberUseCase;
  let grantAccountAccess: GrantAccountAccessUseCase;
  let getOrganizationMembers: GetOrganizationMembersUseCase;
  let getOrganizationMemberList: GetOrganizationMemberListUseCase;
  let getAccountMember: GetAccountMemberUseCase;
  let updateAccountMember: UpdateAccountMemberUseCase;
  let revokeAccountAccess: RevokeAccountAccessUseCase;
  let accountRepository: ReturnType<typeof createMockRepository>;
  let userRepository: ReturnType<typeof createMockRepository>;
  let accountService: {
    removeAccountFromCatalog: jest.Mock;
    appendAccountToCatalog: jest.Mock;
    assertHasOrganizationPermission: jest.Mock;
  };
  let rolesService: {
    findByIdOrFail: jest.Mock;
    findAssignableRoleOrFail: jest.Mock;
    listPermissionsByRoleIds: jest.Mock;
    assertHasPermission: jest.Mock;
    findSystemRoleByName: jest.Mock;
  };

  beforeEach(async () => {
    accountRepository = createMockRepository();
    userRepository = createMockRepository();
    accountRepository.count.mockResolvedValue(2); // por defecto: hay más de un ADMIN activo, nada que proteger
    accountService = {
      removeAccountFromCatalog: jest.fn(),
      appendAccountToCatalog: jest.fn(),
      // Espeja al real: devuelve la cuenta ACTIVA del llamador, de la que sale el organizationId.
      assertHasOrganizationPermission: jest
        .fn()
        .mockResolvedValue(adminAccount()),
    };
    rolesService = {
      findByIdOrFail: jest.fn().mockResolvedValue(MEMBER_ROLE),
      findAssignableRoleOrFail: jest.fn().mockResolvedValue(MEMBER_ROLE),
      listPermissionsByRoleIds: jest
        .fn()
        .mockResolvedValue(new Map([[MEMBER_ROLE.id, MEMBER_PERMISSIONS]])),
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
        AddOrganizationMemberUseCase,
        GrantAccountAccessUseCase,
        GetOrganizationMembersUseCase,
        GetOrganizationMemberListUseCase,
        GetAccountMemberUseCase,
        UpdateAccountMemberUseCase,
        RevokeAccountAccessUseCase,
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

    addOrganizationMember = module.get(AddOrganizationMemberUseCase);
    grantAccountAccess = module.get(GrantAccountAccessUseCase);
    getOrganizationMembers = module.get(GetOrganizationMembersUseCase);
    getOrganizationMemberList = module.get(GetOrganizationMemberListUseCase);
    getAccountMember = module.get(GetAccountMemberUseCase);
    updateAccountMember = module.get(UpdateAccountMemberUseCase);
    revokeAccountAccess = module.get(RevokeAccountAccessUseCase);
  });

  describe('GrantAccountAccessUseCase', () => {
    const dto = {
      organizationId: 'org-1',
      userId: 'user-1',
      roleId: MEMBER_ROLE.id,
    };

    it('rechaza con ConflictException si el usuario ya tiene acceso a la organización', async () => {
      accountRepository.findOne
        .mockResolvedValueOnce(adminAccount()) // ownership check del llamador
        .mockResolvedValueOnce({ id: 'existing' }); // ya existe la membresía a crear

      await expect(grantAccountAccess.execute('owner-1', dto)).rejects.toThrow(
        ConflictException,
      );
    });

    it('lanza ForbiddenException si el llamador no es ADMIN activo de la organización', async () => {
      accountRepository.findOne.mockResolvedValue(null);

      await expect(
        grantAccountAccess.execute('not-owner', dto),
      ).rejects.toThrow(ForbiddenException);
    });

    it('lanza NotFoundException si el roleId no corresponde a un rol existente', async () => {
      accountRepository.findOne.mockResolvedValue(adminAccount());
      rolesService.findAssignableRoleOrFail.mockRejectedValue(
        new NotFoundException('Rol con ID bad-role no encontrado'),
      );

      await expect(
        grantAccountAccess.execute('owner-1', { ...dto, roleId: 'bad-role' }),
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

      await grantAccountAccess.execute('owner-1', dto);

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

  describe('GetOrganizationMembersUseCase', () => {
    it('retorna los miembros si el llamador es ADMIN activo de la organización', async () => {
      accountRepository.findOne.mockResolvedValue(adminAccount());
      accountRepository.find.mockResolvedValue([adminAccount()]);

      const result = await getOrganizationMembers.execute('owner-1', 'org-1');

      expect(result.data).toHaveLength(1);
    });

    it('lanza ForbiddenException si el llamador no es ADMIN activo de la organización', async () => {
      accountRepository.findOne.mockResolvedValue(null);

      await expect(
        getOrganizationMembers.execute('not-owner', 'org-1'),
      ).rejects.toThrow(ForbiddenException);
      expect(accountRepository.find).not.toHaveBeenCalled();
    });

    it('solo consulta miembros activos (un miembro eliminado no debe reaparecer)', async () => {
      accountRepository.findOne.mockResolvedValue(adminAccount());
      accountRepository.find.mockResolvedValue([]);

      await getOrganizationMembers.execute('owner-1', 'org-1');

      expect(accountRepository.find).toHaveBeenCalledWith({
        where: { organizationId: 'org-1', isActive: true },
      });
    });
  });

  describe('GetOrganizationMemberListUseCase', () => {
    it('mapea email/rfc/rol/fecha de ingreso desde el join a user.personalInformation y role', async () => {
      accountRepository.findOne.mockResolvedValue(adminAccount());
      accountRepository.find.mockResolvedValue([
        {
          id: 'account-1',
          userId: 'user-1',
          email: 'miembro@empresa.com',
          roleId: MEMBER_ROLE.id,
          role: { id: 'member-role-1', name: 'MEMBER' },
          joinedAt: new Date('2023-10-25T10:00:00Z'),
          status: ACCOUNT_STATUS_ENUM.ACTIVE,
          isActive: true,
          user: { personalInformation: { rfc: 'XAXX010101000' } },
        },
        {
          id: 'account-2',
          userId: 'user-2',
          email: 'sin-rfc@empresa.com',
          roleId: null,
          role: null,
          joinedAt: null,
          status: ACCOUNT_STATUS_ENUM.ACTIVE,
          isActive: true,
          user: { personalInformation: { rfc: null } },
        },
      ]);

      const result = await getOrganizationMemberList.execute(
        'owner-1',
        'org-1',
      );

      expect(accountRepository.find).toHaveBeenCalledWith({
        where: { organizationId: 'org-1', isActive: true },
        relations: { user: { personalInformation: true }, role: true },
        order: { joinedAt: 'ASC' },
      });
      expect(result.data).toEqual([
        {
          accountId: 'account-1',
          userId: 'user-1',
          email: 'miembro@empresa.com',
          rfc: 'XAXX010101000',
          role: { id: 'member-role-1', name: 'MEMBER' },
          joinedAt: new Date('2023-10-25T10:00:00Z'),
          status: ACCOUNT_STATUS_ENUM.ACTIVE,
          isActive: true,
          permissions: MEMBER_PERMISSIONS,
        },
        {
          accountId: 'account-2',
          userId: 'user-2',
          email: 'sin-rfc@empresa.com',
          rfc: null,
          role: null,
          joinedAt: null,
          status: ACCOUNT_STATUS_ENUM.ACTIVE,
          isActive: true,
          permissions: [],
        },
      ]);
    });

    /**
     * Los permisos son los del rol y se resuelven en UNA consulta para toda la tabla: si se
     * pidieran por fila, una organización de treinta personas dispararía treinta consultas.
     */
    it('resuelve los permisos de todos los miembros con una sola consulta de roles', async () => {
      accountRepository.findOne.mockResolvedValue(adminAccount());
      accountRepository.find.mockResolvedValue([
        {
          id: 'account-1',
          userId: 'user-1',
          email: 'uno@empresa.com',
          roleId: MEMBER_ROLE.id,
          role: MEMBER_ROLE,
          isActive: true,
          status: ACCOUNT_STATUS_ENUM.ACTIVE,
          user: { personalInformation: { rfc: null } },
        },
        {
          id: 'account-2',
          userId: 'user-2',
          email: 'dos@empresa.com',
          roleId: MEMBER_ROLE.id,
          role: MEMBER_ROLE,
          isActive: true,
          status: ACCOUNT_STATUS_ENUM.ACTIVE,
          user: { personalInformation: { rfc: null } },
        },
      ]);

      await getOrganizationMemberList.execute('owner-1', 'org-1');

      expect(rolesService.listPermissionsByRoleIds).toHaveBeenCalledTimes(1);
      expect(rolesService.listPermissionsByRoleIds).toHaveBeenCalledWith([
        MEMBER_ROLE.id,
        MEMBER_ROLE.id,
      ]);
    });

    /**
     * Por defecto la tabla no muestra a quien fue dado de baja; la vista de administración puede
     * pedirlo explícitamente para poder explicar por qué ese correo ya no se puede volver a
     * agregar.
     */
    it('incluye las membresías dadas de baja sólo cuando se piden', async () => {
      accountRepository.findOne.mockResolvedValue(adminAccount());
      accountRepository.find.mockResolvedValue([]);

      await getOrganizationMemberList.execute('owner-1', 'org-1', true);

      expect(accountRepository.find).toHaveBeenCalledWith({
        where: { organizationId: 'org-1' },
        relations: { user: { personalInformation: true }, role: true },
        order: { joinedAt: 'ASC' },
      });
    });

    it('lanza ForbiddenException si el llamador no es ADMIN activo de la organización', async () => {
      accountRepository.findOne.mockResolvedValue(null);

      await expect(
        getOrganizationMemberList.execute('not-owner', 'org-1'),
      ).rejects.toThrow(ForbiddenException);
      expect(accountRepository.find).not.toHaveBeenCalled();
    });
  });

  describe('GetAccountMemberUseCase y UpdateAccountMemberUseCase', () => {
    it('findOne permite al ADMIN de la organización ver la membresía', async () => {
      accountRepository.findOne
        .mockResolvedValueOnce({
          id: 'member-2',
          organizationId: 'org-1',
          userId: 'user-2',
          isActive: true,
        }) // findEntityById
        .mockResolvedValueOnce(adminAccount()); // ownership check

      const result = await getAccountMember.execute('owner-1', 'member-2');

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

      await expect(
        getAccountMember.execute('intruder', 'member-2'),
      ).rejects.toThrow(ForbiddenException);
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
        updateAccountMember.execute('intruder', 'member-2', {
          roleId: MEMBER_ROLE.id,
        }),
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
      rolesService.findAssignableRoleOrFail.mockRejectedValue(
        new NotFoundException('Rol con ID bad-role no encontrado'),
      );

      await expect(
        updateAccountMember.execute('owner-1', 'member-2', {
          roleId: 'bad-role',
        }),
      ).rejects.toThrow(NotFoundException);
      expect(accountRepository.update).not.toHaveBeenCalled();
    });

    it('update lanza ConflictException al degradar el rol del único ADMIN activo de la organización', async () => {
      const targetAdmin = adminAccount({ id: 'admin-account-1' });
      accountRepository.findOne
        .mockResolvedValueOnce(targetAdmin) // findEntityById: el objetivo es ADMIN
        .mockResolvedValueOnce(adminAccount()); // ownership check del llamador
      accountRepository.count.mockResolvedValue(1); // es el único ADMIN activo

      await expect(
        updateAccountMember.execute('owner-1', 'admin-account-1', {
          roleId: MEMBER_ROLE.id,
        }),
      ).rejects.toThrow(ConflictException);
      expect(accountRepository.update).not.toHaveBeenCalled();
    });

    it('update permite degradar a un ADMIN si hay otro ADMIN activo en la organización', async () => {
      const targetAdmin = adminAccount({ id: 'admin-account-2' });
      accountRepository.findOne
        .mockResolvedValueOnce(targetAdmin) // findEntityById
        .mockResolvedValueOnce(adminAccount()) // ownership check del llamador
        .mockResolvedValueOnce(targetAdmin); // findEntityById final, para retornar la data actualizada
      accountRepository.count.mockResolvedValue(2); // hay otro ADMIN activo además del objetivo

      await updateAccountMember.execute('owner-1', 'admin-account-2', {
        roleId: MEMBER_ROLE.id,
      });

      expect(accountRepository.update).toHaveBeenCalled();
    });

    /**
     * El rol se valida contra la organización de la membresía: un rol custom de otra organización
     * existe en la tabla, y aceptarlo movería permisos de un tenant a otro.
     */
    it('update valida el rol nuevo contra la organización de la membresía', async () => {
      const targetMember = {
        id: 'member-2',
        organizationId: 'org-1',
        userId: 'user-2',
        roleId: MEMBER_ROLE.id,
        isActive: true,
      };
      accountRepository.findOne
        .mockResolvedValueOnce(targetMember)
        .mockResolvedValueOnce(adminAccount())
        .mockResolvedValueOnce(targetMember);

      await updateAccountMember.execute('owner-1', 'member-2', {
        roleId: 'other-role',
      });

      expect(rolesService.findAssignableRoleOrFail).toHaveBeenCalledWith(
        'other-role',
        'org-1',
      );
    });

    it('update permite desactivar (isActive:false) a un MEMBER sin pasar por la protección de último ADMIN', async () => {
      const targetMember = {
        id: 'member-2',
        organizationId: 'org-1',
        userId: 'user-2',
        roleId: MEMBER_ROLE.id,
        isActive: true,
      };
      accountRepository.findOne
        .mockResolvedValueOnce(targetMember) // findEntityById
        .mockResolvedValueOnce(adminAccount()) // ownership check del llamador
        .mockResolvedValueOnce(targetMember); // findEntityById final, para retornar la data actualizada

      await updateAccountMember.execute('owner-1', 'member-2', {
        isActive: false,
      });

      expect(accountRepository.count).not.toHaveBeenCalled();
      expect(accountRepository.update).toHaveBeenCalled();
    });
  });

  /**
   * Alta directa desde la pantalla de miembros (`POST /api/v1/organizations/members`). Lo que se
   * prueba aquí es lo que la historia exige: que la organización salga SIEMPRE de la cuenta
   * activa, que el rol se valide contra ella, que no se dupliquen membresías y que la respuesta
   * traiga ya los permisos derivados del rol.
   */
  describe('AddOrganizationMemberUseCase', () => {
    const NEW_USER = {
      id: 'user-9',
      email: 'nueva@empresa.com',
      password: 'hash',
    };

    function savedMembershipRow(overrides: Record<string, unknown> = {}) {
      return {
        id: 'new-member-1',
        userId: NEW_USER.id,
        organizationId: 'org-1',
        email: NEW_USER.email,
        roleId: MEMBER_ROLE.id,
        role: MEMBER_ROLE,
        isActive: true,
        status: ACCOUNT_STATUS_ENUM.ACTIVE,
        joinedAt: new Date('2026-09-10T10:00:00Z'),
        user: { personalInformation: { rfc: null } },
        ...overrides,
      };
    }

    it('crea la membresía con el rol pedido y responde con los permisos que ese rol otorga', async () => {
      userRepository.findOne.mockResolvedValue(NEW_USER);
      accountRepository.findOne
        .mockResolvedValueOnce(null) // no hay membresía previa
        .mockResolvedValueOnce(savedMembershipRow()); // lectura final para la respuesta

      const result = await addOrganizationMember.execute(
        'owner-1',
        'admin-account-1',
        { email: NEW_USER.email, roleId: MEMBER_ROLE.id },
      );

      expect(accountRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: NEW_USER.id,
          organizationId: 'org-1',
          roleId: MEMBER_ROLE.id,
          accountType: ACCOUNT_TYPE_ENUM.ORGANIZATION,
          isActive: true,
          status: ACCOUNT_STATUS_ENUM.ACTIVE,
        }),
      );
      expect(result.data.permissions).toEqual(MEMBER_PERMISSIONS);
      expect(result.data.role).toEqual({
        id: MEMBER_ROLE.id,
        name: MEMBER_ROLE.name,
      });
      expect(result.data.status).toBe(ACCOUNT_STATUS_ENUM.ACTIVE);
    });

    /**
     * Aislamiento multi-tenant: la organización sale de la cuenta activa del llamador, no de nada
     * que venga en la petición. Aunque el administrador de `org-2` conozca el id de `org-1`, el
     * alta aterriza en la suya.
     */
    it('da el alta en la organización de la cuenta activa, no en otra', async () => {
      accountService.assertHasOrganizationPermission.mockResolvedValue(
        adminAccount({ id: 'admin-account-2', organizationId: 'org-2' }),
      );
      userRepository.findOne.mockResolvedValue(NEW_USER);
      accountRepository.findOne
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(savedMembershipRow({ organizationId: 'org-2' }));

      await addOrganizationMember.execute('owner-2', 'admin-account-2', {
        email: NEW_USER.email,
        roleId: MEMBER_ROLE.id,
      });

      expect(rolesService.findAssignableRoleOrFail).toHaveBeenCalledWith(
        MEMBER_ROLE.id,
        'org-2',
      );
      expect(accountRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({ organizationId: 'org-2' }),
      );
    });

    it('lanza ForbiddenException si el llamador no puede administrar esa cuenta', async () => {
      accountService.assertHasOrganizationPermission.mockRejectedValue(
        new ForbiddenException('No tienes permisos de administrador'),
      );

      await expect(
        addOrganizationMember.execute('intruder', 'admin-account-1', {
          email: NEW_USER.email,
          roleId: MEMBER_ROLE.id,
        }),
      ).rejects.toThrow(ForbiddenException);
      expect(accountRepository.save).not.toHaveBeenCalled();
    });

    it('lanza BadRequestException si falta el header X-Account-Id', async () => {
      await expect(
        addOrganizationMember.execute('owner-1', '', {
          email: NEW_USER.email,
          roleId: MEMBER_ROLE.id,
        }),
      ).rejects.toThrow(BadRequestException);
      expect(
        accountService.assertHasOrganizationPermission,
      ).not.toHaveBeenCalled();
    });

    /** Una cuenta personal no tiene miembros que administrar; esta pantalla no aplica. */
    it('lanza BadRequestException si la cuenta activa es PERSONAL', async () => {
      accountService.assertHasOrganizationPermission.mockResolvedValue(
        adminAccount({
          accountType: ACCOUNT_TYPE_ENUM.PERSONAL,
          organizationId: null,
        }),
      );

      await expect(
        addOrganizationMember.execute('owner-1', 'personal-account-1', {
          email: NEW_USER.email,
          roleId: MEMBER_ROLE.id,
        }),
      ).rejects.toThrow(BadRequestException);
      expect(accountRepository.save).not.toHaveBeenCalled();
    });

    it('lanza NotFoundException si el rol no existe o es de otra organización', async () => {
      rolesService.findAssignableRoleOrFail.mockRejectedValue(
        new NotFoundException('Rol no encontrado para esta organización'),
      );

      await expect(
        addOrganizationMember.execute('owner-1', 'admin-account-1', {
          email: NEW_USER.email,
          roleId: 'role-de-otra-org',
        }),
      ).rejects.toThrow(NotFoundException);
      expect(accountRepository.save).not.toHaveBeenCalled();
    });

    it('lanza NotFoundException si no hay un usuario registrado con ese correo', async () => {
      userRepository.findOne.mockResolvedValue(null);

      await expect(
        addOrganizationMember.execute('owner-1', 'admin-account-1', {
          email: 'nadie@empresa.com',
          roleId: MEMBER_ROLE.id,
        }),
      ).rejects.toThrow(NotFoundException);
      expect(accountRepository.save).not.toHaveBeenCalled();
    });

    it('lanza ConflictException si esa persona ya es miembro de la organización', async () => {
      userRepository.findOne.mockResolvedValue(NEW_USER);
      accountRepository.findOne.mockResolvedValueOnce(
        savedMembershipRow({ id: 'existing-1' }),
      );

      await expect(
        addOrganizationMember.execute('owner-1', 'admin-account-1', {
          email: NEW_USER.email,
          roleId: MEMBER_ROLE.id,
        }),
      ).rejects.toThrow(ConflictException);
      expect(accountRepository.save).not.toHaveBeenCalled();
    });

    /**
     * La membresía dada de baja conserva su fila, así que insertar otra dejaría dos del mismo
     * usuario en la misma organización. El mensaje lo distingue porque se arregla distinto:
     * reactivar, no volver a crear.
     */
    it('distingue en el mensaje la membresía dada de baja de la que sigue activa', async () => {
      userRepository.findOne.mockResolvedValue(NEW_USER);
      accountRepository.findOne.mockResolvedValueOnce(
        savedMembershipRow({
          id: 'existing-1',
          isActive: false,
          status: ACCOUNT_STATUS_ENUM.REMOVED,
        }),
      );

      await expect(
        addOrganizationMember.execute('owner-1', 'admin-account-1', {
          email: NEW_USER.email,
          roleId: MEMBER_ROLE.id,
        }),
      ).rejects.toThrow(/dada de baja/);
    });

    /** Sin esto, la organización no le aparece en el selector hasta que vuelva a iniciar sesión. */
    it('agrega la organización al catálogo cacheado del nuevo miembro', async () => {
      userRepository.findOne.mockResolvedValue(NEW_USER);
      accountRepository.findOne
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(savedMembershipRow());

      await addOrganizationMember.execute('owner-1', 'admin-account-1', {
        email: NEW_USER.email,
        roleId: MEMBER_ROLE.id,
      });

      expect(accountService.appendAccountToCatalog).toHaveBeenCalledWith(
        NEW_USER.id,
        expect.objectContaining({ id: 'new-member-1' }),
      );
    });
  });

  describe('RevokeAccountAccessUseCase', () => {
    it('marca isActive=false y quita la cuenta del catálogo cacheado del usuario revocado', async () => {
      accountRepository.findOne
        .mockResolvedValueOnce({
          id: 'member-1',
          organizationId: 'org-1',
          userId: 'user-1',
          isActive: true,
        }) // membresía objetivo
        .mockResolvedValueOnce(adminAccount()); // ownership check del llamador

      const result = await revokeAccountAccess.execute('owner-1', 'member-1');

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

      await expect(
        revokeAccountAccess.execute('owner-1', 'missing-id'),
      ).rejects.toThrow(NotFoundException);
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

      await expect(
        revokeAccountAccess.execute('intruder', 'member-1'),
      ).rejects.toThrow(ForbiddenException);
      expect(accountRepository.update).not.toHaveBeenCalled();
      expect(accountService.removeAccountFromCatalog).not.toHaveBeenCalled();
    });

    it('lanza ConflictException al eliminar al único ADMIN activo de la organización', async () => {
      accountRepository.findOne
        .mockResolvedValueOnce(adminAccount()) // membresía objetivo: es ADMIN
        .mockResolvedValueOnce(adminAccount()); // ownership check del llamador
      accountRepository.count.mockResolvedValue(1); // es el único ADMIN activo

      await expect(
        revokeAccountAccess.execute('owner-1', 'admin-account-1'),
      ).rejects.toThrow(ConflictException);
      expect(accountRepository.update).not.toHaveBeenCalled();
      expect(accountService.removeAccountFromCatalog).not.toHaveBeenCalled();
    });

    it('permite eliminar a un ADMIN si hay otro ADMIN activo en la organización', async () => {
      accountRepository.findOne
        .mockResolvedValueOnce(adminAccount())
        .mockResolvedValueOnce(adminAccount());
      accountRepository.count.mockResolvedValue(2); // hay otro ADMIN activo además del objetivo

      const result = await revokeAccountAccess.execute(
        'owner-1',
        'admin-account-1',
      );

      expect(result.success).toBe(true);
      expect(accountRepository.update).toHaveBeenCalled();
    });
  });
});
