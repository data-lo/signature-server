import { ForbiddenException } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Test, TestingModule } from '@nestjs/testing';

import { AccountEntity } from 'src/account/entities/account.entity';
import { ACTION_KEY_ENUM } from 'src/roles/enums/action-key.enum';
import { PERMISSION_SCOPE_ENUM } from 'src/roles/enums/permission-scope.enum';
import { RESOURCE_KEY_ENUM } from 'src/roles/enums/resource-key.enum';
import { RolesService } from 'src/roles/roles.service';

import { AuthorizationService } from './authorization.service';

/**
 * El servicio se prueba con el `AccountEntity` simulado y `RolesService` doblado: lo que se
 * comprueba aquí es la COMPOSICIÓN —qué fila se busca, en qué orden se decide y qué se devuelve—,
 * no el SQL de los permisos, que es de `RolesService.getPermissionScopes` y tiene su propia
 * prueba.
 *
 * En ningún escenario aparece el nombre de un rol. Es deliberado: las membresías se distinguen
 * sólo por `roleId` y por lo que ese rol tiene concedido, que es exactamente lo que la
 * autorización centralizada vino a sustituir.
 */
describe('AuthorizationService', () => {
  const ADMIN_ROLE_ID = 'role-admin';
  const MEMBER_ROLE_ID = 'role-member';

  let service: AuthorizationService;
  let accountRepository: { findOne: jest.Mock };
  let rolesService: { getPermissionScopes: jest.Mock };

  beforeEach(async () => {
    accountRepository = { findOne: jest.fn() };
    rolesService = { getPermissionScopes: jest.fn().mockResolvedValue([]) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthorizationService,
        {
          provide: getRepositoryToken(AccountEntity),
          useValue: accountRepository,
        },
        { provide: RolesService, useValue: rolesService },
      ],
    }).compile();

    service = module.get(AuthorizationService);
  });

  function organizationMembership(overrides: Partial<AccountEntity> = {}) {
    return {
      id: 'account-1',
      userId: 'user-1',
      organizationId: 'org-1',
      roleId: ADMIN_ROLE_ID,
      isActive: true,
      ...overrides,
    } as AccountEntity;
  }

  describe('resuelve usuario, organización, membresía y rol', () => {
    it('devuelve el contexto completo con los scopes del rol', async () => {
      accountRepository.findOne.mockResolvedValue(organizationMembership());
      rolesService.getPermissionScopes.mockResolvedValue([
        PERMISSION_SCOPE_ENUM.OWN,
        PERMISSION_SCOPE_ENUM.ORGANIZATION,
      ]);

      const context = await service.authorize({
        userId: 'user-1',
        organizationId: 'org-1',
        resource: RESOURCE_KEY_ENUM.DOCUMENT,
        action: ACTION_KEY_ENUM.READ,
      });

      expect(context).toEqual({
        userId: 'user-1',
        organizationId: 'org-1',
        accountId: 'account-1',
        roleId: ADMIN_ROLE_ID,
        resource: RESOURCE_KEY_ENUM.DOCUMENT,
        action: ACTION_KEY_ENUM.READ,
        scopes: [PERMISSION_SCOPE_ENUM.OWN, PERMISSION_SCOPE_ENUM.ORGANIZATION],
      });
    });

    /**
     * La URL manda sobre el header. Un cliente que pida `organizations/org-1/...` con el
     * `X-Account-Id` de otra organización no debe operar sobre la primera, y la forma de
     * cerrarlo es buscar la membresía por `userId + organizationId`: si no existe, no hay nada
     * que autorizar.
     */
    it('busca la membresía por organización cuando la organización viaja en la ruta', async () => {
      accountRepository.findOne.mockResolvedValue(organizationMembership());
      rolesService.getPermissionScopes.mockResolvedValue([
        PERMISSION_SCOPE_ENUM.ANY,
      ]);

      await service.authorize({
        userId: 'user-1',
        organizationId: 'org-1',
        accountId: 'account-de-otra-organizacion',
        resource: RESOURCE_KEY_ENUM.ROLE,
        action: ACTION_KEY_ENUM.READ,
      });

      expect(accountRepository.findOne).toHaveBeenCalledWith({
        where: { userId: 'user-1', organizationId: 'org-1', isActive: true },
      });
    });

    it('busca la membresía por cuenta activa cuando la organización no viaja en la ruta', async () => {
      accountRepository.findOne.mockResolvedValue(organizationMembership());
      rolesService.getPermissionScopes.mockResolvedValue([
        PERMISSION_SCOPE_ENUM.ANY,
      ]);

      await service.authorize({
        userId: 'user-1',
        accountId: 'account-1',
        resource: RESOURCE_KEY_ENUM.BILLING,
        action: ACTION_KEY_ENUM.READ,
      });

      expect(accountRepository.findOne).toHaveBeenCalledWith({
        where: { id: 'account-1', userId: 'user-1', isActive: true },
      });
    });

    /**
     * Una cuenta personal no tiene organización y aun así se autoriza: tiene rol, y su dueño es
     * el único que puede actuar sobre ella. El `null` viaja al contexto para que las Policies
     * puedan distinguirla de un documento de organización.
     */
    it('autoriza una cuenta PERSONAL y deja organizationId en null', async () => {
      accountRepository.findOne.mockResolvedValue(
        organizationMembership({ organizationId: null }),
      );
      rolesService.getPermissionScopes.mockResolvedValue([
        PERMISSION_SCOPE_ENUM.OWN,
      ]);

      const context = await service.authorize({
        userId: 'user-1',
        accountId: 'account-1',
        resource: RESOURCE_KEY_ENUM.DOCUMENT,
        action: ACTION_KEY_ENUM.READ,
      });

      expect(context.organizationId).toBeNull();
    });
  });

  describe('obtiene los scopes por resource + action', () => {
    it('consulta el catálogo con el rol de la membresía, el recurso y la acción', async () => {
      accountRepository.findOne.mockResolvedValue(
        organizationMembership({ roleId: MEMBER_ROLE_ID }),
      );
      rolesService.getPermissionScopes.mockResolvedValue([
        PERMISSION_SCOPE_ENUM.SELF,
      ]);

      const context = await service.authorize({
        userId: 'user-1',
        organizationId: 'org-1',
        resource: RESOURCE_KEY_ENUM.DOCUMENT,
        action: ACTION_KEY_ENUM.SIGN,
      });

      expect(rolesService.getPermissionScopes).toHaveBeenCalledWith(
        MEMBER_ROLE_ID,
        RESOURCE_KEY_ENUM.DOCUMENT,
        ACTION_KEY_ENUM.SIGN,
      );
      expect(context.scopes).toEqual([PERMISSION_SCOPE_ENUM.SELF]);
    });

    /**
     * El mismo usuario, la misma membresía y el mismo rol: lo único que cambia es el permiso que
     * pide el endpoint. Que uno pase y el otro no es lo que demuestra que la decisión sale del
     * catálogo y no de quién es el rol.
     */
    it('el mismo rol pasa para un permiso y es rechazado para otro', async () => {
      accountRepository.findOne.mockResolvedValue(
        organizationMembership({ roleId: MEMBER_ROLE_ID }),
      );
      rolesService.getPermissionScopes.mockImplementation(
        async (_roleId: string, resource: RESOURCE_KEY_ENUM) =>
          resource === RESOURCE_KEY_ENUM.DOCUMENT
            ? [PERMISSION_SCOPE_ENUM.OWN]
            : [],
      );

      await expect(
        service.authorize({
          userId: 'user-1',
          organizationId: 'org-1',
          resource: RESOURCE_KEY_ENUM.DOCUMENT,
          action: ACTION_KEY_ENUM.READ,
        }),
      ).resolves.toMatchObject({ scopes: [PERMISSION_SCOPE_ENUM.OWN] });

      await expect(
        service.authorize({
          userId: 'user-1',
          organizationId: 'org-1',
          resource: RESOURCE_KEY_ENUM.BILLING,
          action: ACTION_KEY_ENUM.READ,
        }),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe('lanza ForbiddenException cuando corresponde', () => {
    it('sin ninguna referencia de cuenta activa, y sin llegar a consultar la base', async () => {
      await expect(
        service.authorize({
          userId: 'user-1',
          resource: RESOURCE_KEY_ENUM.BILLING,
          action: ACTION_KEY_ENUM.READ,
        }),
      ).rejects.toThrow(ForbiddenException);

      expect(accountRepository.findOne).not.toHaveBeenCalled();
    });

    it('cuando no existe una membresía activa del usuario en esa cuenta', async () => {
      accountRepository.findOne.mockResolvedValue(null);

      await expect(
        service.authorize({
          userId: 'user-1',
          organizationId: 'org-1',
          resource: RESOURCE_KEY_ENUM.MEMBER,
          action: ACTION_KEY_ENUM.READ,
        }),
      ).rejects.toThrow(ForbiddenException);

      expect(rolesService.getPermissionScopes).not.toHaveBeenCalled();
    });

    it('cuando la membresía no tiene rol asignado', async () => {
      accountRepository.findOne.mockResolvedValue(
        organizationMembership({ roleId: null }),
      );

      await expect(
        service.authorize({
          userId: 'user-1',
          organizationId: 'org-1',
          resource: RESOURCE_KEY_ENUM.MEMBER,
          action: ACTION_KEY_ENUM.READ,
        }),
      ).rejects.toThrow(ForbiddenException);

      expect(rolesService.getPermissionScopes).not.toHaveBeenCalled();
    });

    it('cuando el rol no tiene concedido el permiso con ningún alcance', async () => {
      accountRepository.findOne.mockResolvedValue(organizationMembership());
      rolesService.getPermissionScopes.mockResolvedValue([]);

      await expect(
        service.authorize({
          userId: 'user-1',
          organizationId: 'org-1',
          resource: RESOURCE_KEY_ENUM.BILLING,
          action: ACTION_KEY_ENUM.MANAGE,
        }),
      ).rejects.toThrow(ForbiddenException);
    });
  });
});
