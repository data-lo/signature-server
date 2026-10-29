import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { In } from 'typeorm';
import { ConflictException, ForbiddenException } from '@nestjs/common';
import { AccountMemberService } from './account-member.service';
import { AccountEntity } from './entities/account.entity';
import { UserEntity } from 'src/user/entities/user.entity';
import { AccountService } from './account.service';
import { RolesService } from 'src/roles/roles.service';
import { SYSTEM_ROLE_NAME_ENUM } from 'src/roles/enums/system-role-name.enum';
import { DuplicateOrganizationMembershipException } from './exceptions/organization.exceptions';
import { ACCOUNT_STATUS_ENUM } from './enums/account-status.enum';
import { RESOURCE_KEY_ENUM } from 'src/roles/enums/resource-key.enum';
import { ACTION_KEY_ENUM } from 'src/roles/enums/action-key.enum';

const OWNER_ROLE = { id: 'owner-role-1', name: SYSTEM_ROLE_NAME_ENUM.OWNER };
const ADMIN_ROLE = { id: 'admin-role-1', name: SYSTEM_ROLE_NAME_ENUM.ADMIN };
const MEMBER_ROLE = { id: 'member-role-1', name: SYSTEM_ROLE_NAME_ENUM.MEMBER };

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

describe('AccountMemberService', () => {
  let service: AccountMemberService;
  let accountRepository: ReturnType<typeof createMockRepository>;
  let userRepository: ReturnType<typeof createMockRepository>;
  let accountService: { removeAccountFromCatalog: jest.Mock };
  let rolesService: {
    findByIdOrFail: jest.Mock;
    assertHasPermission: jest.Mock;
    findSystemRoleByName: jest.Mock;
    hasPermission: jest.Mock;
  };

  beforeEach(async () => {
    accountRepository = createMockRepository();
    userRepository = createMockRepository();
    accountRepository.count.mockResolvedValue(2); // por defecto: hay más de un administrador activo, nada que proteger
    accountService = { removeAccountFromCatalog: jest.fn() };
    rolesService = {
      findByIdOrFail: jest.fn().mockResolvedValue(MEMBER_ROLE),
      // Sólo ADMIN concede DOCUMENT.APPROVE en estas pruebas.
      hasPermission: jest
        .fn()
        .mockImplementation(async (roleId: string) => roleId === ADMIN_ROLE.id),
      // Resuelve por nombre: `assertNotLastAdmin` pide OWNER y ADMIN, y devolver siempre el
      // mismo rol escondería que los cuenta a los dos.
      findSystemRoleByName: jest
        .fn()
        .mockImplementation(async (name: SYSTEM_ROLE_NAME_ENUM) =>
          name === SYSTEM_ROLE_NAME_ENUM.OWNER ? OWNER_ROLE : ADMIN_ROLE,
        ),
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

  /**
   * Protección del último administrador. Desde que el creador de la cuenta nace con el rol
   * OWNER (ver `IntroduceOwnerSystemRole1784300000055`), "el último que puede administrar" ya no
   * es "el último ADMIN": OWNER y ADMIN se cuentan juntos.
   */
  describe('assertNotLastAdmin', () => {
    const MEMBER = {
      id: 'account-2',
      organizationId: 'org-1',
      roleId: MEMBER_ROLE.id,
    } as AccountEntity;
    const OWNER = {
      id: 'account-1',
      organizationId: 'org-1',
      roleId: OWNER_ROLE.id,
    } as AccountEntity;
    const ADMIN = {
      id: 'account-3',
      organizationId: 'org-1',
      roleId: ADMIN_ROLE.id,
    } as AccountEntity;

    it('no comprueba nada si el miembro no administra la organización', async () => {
      await expect(
        service.assertNotLastAdmin('org-1', MEMBER),
      ).resolves.toBeUndefined();

      expect(accountRepository.count).not.toHaveBeenCalled();
    });

    it('cuenta juntos a los OWNER y a los ADMIN activos de la organización', async () => {
      await service.assertNotLastAdmin('org-1', OWNER);

      expect(accountRepository.count).toHaveBeenCalledWith({
        where: {
          organizationId: 'org-1',
          isActive: true,
          roleId: In([OWNER_ROLE.id, ADMIN_ROLE.id]),
        },
      });
    });

    it('impide degradar al propietario si es el único administrador activo', async () => {
      accountRepository.count.mockResolvedValue(1);

      await expect(service.assertNotLastAdmin('org-1', OWNER)).rejects.toThrow(
        ConflictException,
      );
    });

    /**
     * El ADMIN nombrado por el propietario sí se puede degradar mientras el propietario siga
     * activo: la organización no se queda sin nadie que la gestione.
     */
    it('deja degradar a un ADMIN si el propietario sigue activo', async () => {
      accountRepository.count.mockResolvedValue(2);

      await expect(
        service.assertNotLastAdmin('org-1', ADMIN),
      ).resolves.toBeUndefined();
    });
  });

  /**
   * Historia "Corregir carga de aprobadores al requerir aprobación durante la creación de
   * documentos": la lista de la que se elige al aprobador.
   */
  describe('listActiveMembersWithPermission', () => {
    function membership(id: string, roleId: string | null) {
      return {
        id,
        userId: `user-${id}`,
        organizationId: 'org-1',
        roleId,
        isActive: true,
        user: { id: `user-${id}`, email: `${id}@empresa.com` },
      };
    }

    it('consulta sólo membresías activas y en estado ACTIVE de esa organización', async () => {
      accountRepository.find.mockResolvedValue([]);

      await service.listActiveMembersWithPermission(
        'org-1',
        RESOURCE_KEY_ENUM.DOCUMENT,
        ACTION_KEY_ENUM.APPROVE,
      );

      expect(accountRepository.find).toHaveBeenCalledWith({
        where: {
          organizationId: 'org-1',
          isActive: true,
          status: ACCOUNT_STATUS_ENUM.ACTIVE,
        },
        relations: { user: true },
        order: { createdAt: 'ASC' },
      });
    });

    it('devuelve sólo a quienes tienen un rol con el permiso', async () => {
      accountRepository.find.mockResolvedValue([
        membership('a', ADMIN_ROLE.id),
        membership('m', MEMBER_ROLE.id),
        membership('sin-rol', null),
        membership('b', ADMIN_ROLE.id),
      ]);

      const result = await service.listActiveMembersWithPermission(
        'org-1',
        RESOURCE_KEY_ENUM.DOCUMENT,
        ACTION_KEY_ENUM.APPROVE,
      );

      expect(result.map((member) => member.id)).toEqual(['a', 'b']);
    });

    it('resuelve el permiso una vez por rol, no por miembro', async () => {
      accountRepository.find.mockResolvedValue([
        membership('a', ADMIN_ROLE.id),
        membership('b', ADMIN_ROLE.id),
        membership('m', MEMBER_ROLE.id),
      ]);

      await service.listActiveMembersWithPermission(
        'org-1',
        RESOURCE_KEY_ENUM.DOCUMENT,
        ACTION_KEY_ENUM.APPROVE,
      );

      expect(rolesService.hasPermission).toHaveBeenCalledTimes(2);
      expect(rolesService.hasPermission).toHaveBeenCalledWith(
        ADMIN_ROLE.id,
        RESOURCE_KEY_ENUM.DOCUMENT,
        ACTION_KEY_ENUM.APPROVE,
      );
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
  describe('saveMembership', () => {
    const DTO = {
      organizationId: 'org-1',
      userId: 'user-1',
      roleId: MEMBER_ROLE.id,
    };
    const INVITED_USER = {
      id: 'user-1',
      email: 'invitado@empresa.com',
      password: 'hashed-pw',
    } as UserEntity;

    it('guarda la membresía activa, con su rol y sus credenciales sincronizadas', async () => {
      await service.saveMembership(DTO as never, INVITED_USER);

      expect(accountRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'user-1',
          organizationId: 'org-1',
          roleId: MEMBER_ROLE.id,
          isActive: true,
          email: INVITED_USER.email,
          password: INVITED_USER.password,
        }),
      );
    });

    /**
     * Los casos de uso comprueban antes si ya existe la membresía, pero leer y después escribir
     * no aguanta dos peticiones a la vez: ambas leen "no existe" y ambas insertan. La segunda
     * choca contra el índice único de `accounts` y tiene que salir como el mismo 409 que habría
     * dado la comprobación, no como un 500 con el texto de Postgres.
     */
    it('traduce el choque contra el índice único a un 409 de membresía duplicada', async () => {
      accountRepository.save.mockRejectedValue(
        Object.assign(
          new Error('duplicate key value violates unique constraint'),
          {
            code: '23505',
            constraint: 'UQ_accounts_user_id_organization_id',
          },
        ),
      );

      await expect(
        service.saveMembership(DTO as never, INVITED_USER),
      ).rejects.toThrow(DuplicateOrganizationMembershipException);
    });

    /** Cualquier otro fallo de escritura sigue saliendo tal cual: no todo 500 es un duplicado. */
    it('no disfraza de duplicado un error distinto', async () => {
      accountRepository.save.mockRejectedValue(
        Object.assign(new Error('null value in column "email"'), {
          code: '23502',
        }),
      );

      await expect(
        service.saveMembership(DTO as never, INVITED_USER),
      ).rejects.toThrow('null value in column "email"');
    });
  });
});
