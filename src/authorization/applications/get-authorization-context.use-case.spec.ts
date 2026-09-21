import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Test, TestingModule } from '@nestjs/testing';

import { AccountEntity } from 'src/account/entities/account.entity';
import { ACCOUNT_TYPE_ENUM } from 'src/account/enums/account-type.enum';
import { RolesService } from 'src/roles/roles.service';
import { STATIC_PERMISSION_KEY_ENUM } from 'src/roles/static-permission-catalog';

import { GetAuthorizationContextUseCase } from './get-authorization-context.use-case';

describe('GetAuthorizationContextUseCase', () => {
  let useCase: GetAuthorizationContextUseCase;
  let accountRepository: { findOne: jest.Mock };
  let rolesService: { listPermissionsByRoleIds: jest.Mock };

  beforeEach(async () => {
    accountRepository = { findOne: jest.fn() };
    rolesService = {
      listPermissionsByRoleIds: jest.fn().mockResolvedValue(new Map()),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GetAuthorizationContextUseCase,
        {
          provide: getRepositoryToken(AccountEntity),
          useValue: accountRepository,
        },
        { provide: RolesService, useValue: rolesService },
      ],
    }).compile();

    useCase = module.get(GetAuthorizationContextUseCase);
  });

  function organizationMembership(overrides: Partial<AccountEntity> = {}) {
    return {
      id: 'account-1',
      userId: 'user-1',
      accountType: ACCOUNT_TYPE_ENUM.ORGANIZATION,
      organizationId: 'org-1',
      roleId: 'role-1',
      isActive: true,
      ...overrides,
    } as AccountEntity;
  }

  /** Lo que devuelve `listPermissionsByRoleIds`, recortado a lo que este caso de uso mira. */
  function grant(key: string, isStaticCatalog = true) {
    return { key, isStaticCatalog } as never;
  }

  it('devuelve cuenta, tipo, organización, rol y permisos efectivos', async () => {
    accountRepository.findOne.mockResolvedValue(organizationMembership());
    rolesService.listPermissionsByRoleIds.mockResolvedValue(
      new Map([
        [
          'role-1',
          [
            grant(STATIC_PERMISSION_KEY_ENUM.ORGANIZATION_READ),
            grant(STATIC_PERMISSION_KEY_ENUM.DOCUMENT_CREATE),
            grant(STATIC_PERMISSION_KEY_ENUM.DOCUMENT_READ_OWN),
          ],
        ],
      ]),
    );

    const response = await useCase.execute('user-1', 'account-1');

    expect(response.data).toEqual({
      accountId: 'account-1',
      accountType: ACCOUNT_TYPE_ENUM.ORGANIZATION,
      organizationId: 'org-1',
      roleId: 'role-1',
      permissions: [
        STATIC_PERMISSION_KEY_ENUM.ORGANIZATION_READ,
        STATIC_PERMISSION_KEY_ENUM.DOCUMENT_CREATE,
        STATIC_PERMISSION_KEY_ENUM.DOCUMENT_READ_OWN,
      ],
    });
  });

  /**
   * La rejilla CRUD heredada del seed anterior sigue en la base y se le concede a los roles de
   * sistema. Publicarla obligaría a la unión de tipos del frontend a crecer con claves que no
   * describen ninguna capacidad de negocio.
   */
  it('descarta las claves que no pertenecen al catálogo estático', async () => {
    accountRepository.findOne.mockResolvedValue(organizationMembership());
    rolesService.listPermissionsByRoleIds.mockResolvedValue(
      new Map([
        [
          'role-1',
          [
            grant(STATIC_PERMISSION_KEY_ENUM.BILLING_READ),
            grant('USER.DELETE', false),
            grant('ORGANIZATION.CREATE', false),
          ],
        ],
      ]),
    );

    const response = await useCase.execute('user-1', 'account-1');

    expect(response.data.permissions).toEqual([
      STATIC_PERMISSION_KEY_ENUM.BILLING_READ,
    ]);
  });

  it('una cuenta PERSONAL responde con organizationId en null', async () => {
    accountRepository.findOne.mockResolvedValue(
      organizationMembership({
        accountType: ACCOUNT_TYPE_ENUM.PERSONAL,
        organizationId: null,
      }),
    );

    const response = await useCase.execute('user-1', 'account-1');

    expect(response.data.accountType).toBe(ACCOUNT_TYPE_ENUM.PERSONAL);
    expect(response.data.organizationId).toBeNull();
  });

  /**
   * Lo que de verdad decide el menú de una cuenta personal. La cuenta trae el rol OWNER —el que
   * le da el alta, y el que concede el catálogo entero—, así que doblar `listPermissionsByRoleIds`
   * no hace falta: si el caso de uso llegara a consultarlo, la lista publicada traería
   * ORGANIZATION, MEMBER y ROLE, que es justo lo que no debe ver.
   */
  describe('cuenta PERSONAL', () => {
    function personalAccount(overrides: Partial<AccountEntity> = {}) {
      return organizationMembership({
        accountType: ACCOUNT_TYPE_ENUM.PERSONAL,
        organizationId: null,
        roleId: 'role-owner',
        ...overrides,
      });
    }

    it('publica facturación y sus documentos, sin consultar el rol', async () => {
      accountRepository.findOne.mockResolvedValue(personalAccount());

      const response = await useCase.execute('user-1', 'account-1');

      expect(response.data.permissions).toEqual([
        STATIC_PERMISSION_KEY_ENUM.BILLING_READ,
        STATIC_PERMISSION_KEY_ENUM.BILLING_MANAGE,
        STATIC_PERMISSION_KEY_ENUM.DOCUMENT_CREATE,
        STATIC_PERMISSION_KEY_ENUM.DOCUMENT_READ_OWN,
        STATIC_PERMISSION_KEY_ENUM.DOCUMENT_SEND_SIGNATURE_REQUEST,
        STATIC_PERMISSION_KEY_ENUM.DOCUMENT_SIGN_SELF,
        STATIC_PERMISSION_KEY_ENUM.DOCUMENT_CANCEL,
      ]);
      expect(rolesService.listPermissionsByRoleIds).not.toHaveBeenCalled();
    });

    /**
     * `BILLING.READ` es lo que le abre Planes y Suscripciones en el menú (ver
     * `navigation-permissions.ts` en signature-app), y `MEMBER.READ`/`ROLE.READ` lo que le
     * abriría Administrar miembros y Roles y permisos. Se comprueban por nombre porque es
     * exactamente lo que pide la historia.
     */
    it('ve Planes y Suscripciones, y no ve miembros, roles ni organizaciones', async () => {
      accountRepository.findOne.mockResolvedValue(personalAccount());

      const { permissions } = (await useCase.execute('user-1', 'account-1'))
        .data;

      expect(permissions).toContain(STATIC_PERMISSION_KEY_ENUM.BILLING_READ);
      expect(permissions).toContain(STATIC_PERMISSION_KEY_ENUM.BILLING_MANAGE);
      expect(permissions).not.toContain(STATIC_PERMISSION_KEY_ENUM.MEMBER_READ);
      expect(permissions).not.toContain(STATIC_PERMISSION_KEY_ENUM.ROLE_READ);
      expect(permissions).not.toContain(
        STATIC_PERMISSION_KEY_ENUM.ORGANIZATION_READ,
      );
      expect(permissions).not.toContain(
        STATIC_PERMISSION_KEY_ENUM.DOCUMENT_READ_ORGANIZATION,
      );
    });

    /**
     * Una cuenta personal vieja, de las que se dieron de alta sin rol: recibe los mismos permisos
     * que una nueva. Antes salía con la lista vacía, y con ella un menú sin nada.
     */
    it('una cuenta personal SIN rol recibe los mismos permisos', async () => {
      accountRepository.findOne.mockResolvedValue(
        personalAccount({ roleId: null }),
      );

      const response = await useCase.execute('user-1', 'account-1');

      expect(response.data.roleId).toBeNull();
      expect(response.data.permissions).toContain(
        STATIC_PERMISSION_KEY_ENUM.BILLING_READ,
      );
      expect(response.data.permissions).toHaveLength(7);
    });
  });

  /**
   * El RBAC de las organizaciones no se movió: publica lo que su rol concede, ni más ni menos.
   */
  it('una cuenta ORGANIZATION conserva exactamente los permisos de su rol', async () => {
    accountRepository.findOne.mockResolvedValue(organizationMembership());
    rolesService.listPermissionsByRoleIds.mockResolvedValue(
      new Map([
        [
          'role-1',
          [
            grant(STATIC_PERMISSION_KEY_ENUM.MEMBER_READ),
            grant(STATIC_PERMISSION_KEY_ENUM.DOCUMENT_READ_ORGANIZATION),
          ],
        ],
      ]),
    );

    const response = await useCase.execute('user-1', 'account-1');

    expect(rolesService.listPermissionsByRoleIds).toHaveBeenCalledWith([
      'role-1',
    ]);
    expect(response.data.permissions).toEqual([
      STATIC_PERMISSION_KEY_ENUM.MEMBER_READ,
      STATIC_PERMISSION_KEY_ENUM.DOCUMENT_READ_ORGANIZATION,
    ]);
  });

  /**
   * Una membresía sin rol no es un error: `accounts.role_id` es nullable y significa "todavía no
   * puede hacer nada". El menú sale vacío, que es lo correcto, en vez de una pantalla de error.
   */
  it('una membresía de organización sin rol devuelve la lista vacía, sin consultar el catálogo', async () => {
    accountRepository.findOne.mockResolvedValue(
      organizationMembership({ roleId: null }),
    );

    const response = await useCase.execute('user-1', 'account-1');

    expect(response.data.permissions).toEqual([]);
    expect(rolesService.listPermissionsByRoleIds).not.toHaveBeenCalled();
  });

  describe('pertenencia a la cuenta', () => {
    /**
     * El `where` lleva el `userId` del JWT: que la cuenta sea del llamador se comprueba en la
     * consulta, no después. Filtrar en memoria haría que una cuenta ajena y una inexistente
     * recorrieran caminos distintos, y de ahí sale el 404 que confirma qué ids existen.
     */
    it('busca la membresía por cuenta Y usuario autenticado', async () => {
      accountRepository.findOne.mockResolvedValue(organizationMembership());

      await useCase.execute('user-1', 'account-1');

      expect(accountRepository.findOne).toHaveBeenCalledWith({
        where: { id: 'account-1', userId: 'user-1', isActive: true },
      });
    });

    it('responde 403 cuando la cuenta no es del usuario o está dada de baja', async () => {
      accountRepository.findOne.mockResolvedValue(null);

      await expect(useCase.execute('user-1', 'account-ajena')).rejects.toThrow(
        ForbiddenException,
      );
      expect(rolesService.listPermissionsByRoleIds).not.toHaveBeenCalled();
    });

    it('responde 400 cuando la petición no declara cuenta activa', async () => {
      await expect(useCase.execute('user-1', undefined)).rejects.toThrow(
        BadRequestException,
      );
      expect(accountRepository.findOne).not.toHaveBeenCalled();
    });
  });
});
