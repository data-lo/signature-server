import {
  CanActivate,
  ExecutionContext,
  INestApplication,
} from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import * as request from 'supertest';

import { AccountEntity } from './../src/account/entities/account.entity';
import { OrganizationsController } from './../src/account/organizations.controller';
import { PermissionsGuard } from './../src/authorization/guards/permissions.guard';
import { AuthorizationService } from './../src/authorization/services/authorization.service';
import { DocumentController } from './../src/document/document.controller';
import { OrganizationPermissionsController } from './../src/organization-permissions/organization-permissions.controller';
import { PaymentsController } from './../src/payments/payments.controller';
import { OrganizationRolesController } from './../src/roles/organization-roles.controller';
import { ACTION_KEY_ENUM } from './../src/roles/enums/action-key.enum';
import { PERMISSION_SCOPE_ENUM } from './../src/roles/enums/permission-scope.enum';
import { RESOURCE_KEY_ENUM } from './../src/roles/enums/resource-key.enum';
import { SYSTEM_ROLE_NAME_ENUM } from './../src/roles/enums/system-role-name.enum';
import { RolesService } from './../src/roles/roles.service';
import {
  STATIC_PERMISSION_CATALOG,
  STATIC_ROLE_PERMISSION_MATRIX,
} from './../src/roles/static-permission-catalog';

import { DOCUMENT_CONTROLLER_USE_CASE_STUBS } from './document-controller-use-case-stubs';
import { ArchiveCompletedDocumentUseCase } from './../src/document/applications/archive-document.use-case';
import { SignDocumentUseCase } from './../src/document/applications/sign-document.use-case';
import { GetDocumentUseCase } from './../src/document/applications/get-document.use-case';

// Use cases de los controllers no documentales, doblados: esta prueba no los ejercita.
import { CreateOrganizationUseCase } from './../src/account/applications/create-organization.use-case';
import { InviteOrganizationMemberUseCase } from './../src/account/applications/invite-organization-member.use-case';
import { AddOrganizationMemberUseCase } from './../src/account/applications/add-organization-member.use-case';
import { GetOrganizationMemberListUseCase } from './../src/account/applications/get-organization-member-list.use-case';
import { UpdateAccountMemberUseCase } from './../src/account/applications/update-account-member.use-case';
import { RevokeAccountAccessUseCase } from './../src/account/applications/revoke-account-access.use-case';
import { GetMemberPermissionsUseCase } from './../src/organization-permissions/applications/get-member-permissions.use-case';
import { AssignMemberPermissionsUseCase } from './../src/organization-permissions/applications/assign-member-permissions.use-case';
import { GetOrganizationPermissionsUseCase } from './../src/organization-permissions/applications/get-organization-permissions.use-case';
import { CreateOrganizationPermissionUseCase } from './../src/organization-permissions/applications/create-organization-permission.use-case';
import { UpdateOrganizationPermissionUseCase } from './../src/organization-permissions/applications/update-organization-permission.use-case';
import { DeleteOrganizationPermissionUseCase } from './../src/organization-permissions/applications/delete-organization-permission.use-case';
import { ListOrganizationRolesUseCase } from './../src/roles/applications/list-organization-roles.use-case';
import { CreateOrganizationRoleUseCase } from './../src/roles/applications/create-organization-role.use-case';
import { UpdateOrganizationRoleUseCase } from './../src/roles/applications/update-organization-role.use-case';
import { GetPublicStripePlansUseCase } from './../src/payments/applications/get-public-stripe-plans.use-case';
import { CreateSubscriptionCheckoutUseCase } from './../src/billing/checkout/create-subscription-checkout.use-case';
import { CreateDocumentCreditCheckoutUseCase } from './../src/billing/checkout/create-document-credit-checkout.use-case';
import { GetAvailableDocumentCreditOffersUseCase } from './../src/billing/credits/get-available-document-credit-offers.use-case';
import { CancelSubscriptionUseCase } from './../src/billing/subscriptions/cancel-subscription.use-case';
import { ResumeSubscriptionUseCase } from './../src/billing/subscriptions/resume-subscription.use-case';
import { GetBillingAccessUseCase } from './../src/billing/entitlements/get-billing-access.use-case';

/**
 * Autorización de punta a punta, un endpoint por recurso del catálogo.
 *
 * Lo que se monta es la cadena REAL —`@RequirePermission` → `PermissionsGuard` →
 * `AuthorizationService` → scopes del rol— con dos cosas simuladas y ninguna más: la tabla
 * `accounts` (un puñado de membresías en memoria) y la consulta de permisos, que aquí se resuelve
 * contra el catálogo estático en código en vez de contra Postgres.
 *
 * Esa segunda sustitución es deliberada y es la mitad del valor de la prueba: `getPermissionScopes`
 * se responde leyendo `STATIC_ROLE_PERMISSION_MATRIX`, la misma matriz que siembra
 * `npm run seed:static-permissions`. Así, que un MEMBER reciba 403 en facturación y un OWNER 200
 * no es algo que decida el doble, sino el catálogo — y si mañana alguien le agregara
 * `BILLING.READ` a MEMBER, esta prueba se enteraría.
 *
 * Los casos de uso van todos doblados: lo que se comprueba es quién LLEGA a ellos.
 */
describe('Autorización por permisos (e2e)', () => {
  const USER_ID = 'user-1';
  const ORGANIZATION_ID = 'org-1';

  /** Una membresía por rol de sistema, todas del mismo usuario en la misma organización. */
  const MEMBERSHIPS: Record<SYSTEM_ROLE_NAME_ENUM, Partial<AccountEntity>> = {
    [SYSTEM_ROLE_NAME_ENUM.OWNER]: {
      id: 'account-owner',
      userId: USER_ID,
      organizationId: ORGANIZATION_ID,
      roleId: SYSTEM_ROLE_NAME_ENUM.OWNER,
      isActive: true,
    },
    [SYSTEM_ROLE_NAME_ENUM.ADMIN]: {
      id: 'account-admin',
      userId: USER_ID,
      organizationId: ORGANIZATION_ID,
      roleId: SYSTEM_ROLE_NAME_ENUM.ADMIN,
      isActive: true,
    },
    [SYSTEM_ROLE_NAME_ENUM.MEMBER]: {
      id: 'account-member',
      userId: USER_ID,
      organizationId: ORGANIZATION_ID,
      roleId: SYSTEM_ROLE_NAME_ENUM.MEMBER,
      isActive: true,
    },
  };

  let app: INestApplication;
  /** Rol con el que responderá la tabla `accounts` en la petición en curso. */
  let activeRole: SYSTEM_ROLE_NAME_ENUM | null;

  /**
   * Los scopes que el catálogo estático le concede a un rol de sistema para `resource + action`.
   *
   * Es la traducción exacta de lo que hace `RolesService.getPermissionScopes` contra la base,
   * hecha sobre la fuente de verdad en código: recorre los permisos que la matriz le da al rol y
   * se queda con los que apuntan a ese recurso y esa acción.
   *
   * @param roleName - Rol de sistema de la membresía activa.
   * @param resource - Recurso declarado por el endpoint.
   * @param action - Acción declarada por el endpoint.
   * @returns Los alcances concedidos; vacío si el rol no tiene ese permiso.
   *
   * @example
   * ```ts
   * scopesFromCatalog(SYSTEM_ROLE_NAME_ENUM.MEMBER, RESOURCE_KEY_ENUM.BILLING, ACTION_KEY_ENUM.READ);
   * // []
   * ```
   */
  function scopesFromCatalog(
    roleName: SYSTEM_ROLE_NAME_ENUM,
    resource: RESOURCE_KEY_ENUM,
    action: ACTION_KEY_ENUM,
  ): PERMISSION_SCOPE_ENUM[] {
    return STATIC_ROLE_PERMISSION_MATRIX[roleName]
      .map((key) => STATIC_PERMISSION_CATALOG[key])
      .filter(
        (definition) =>
          definition.resource === resource && definition.action === action,
      )
      .map((definition) => definition.scope);
  }

  beforeAll(async () => {
    /**
     * Ocupa el lugar de `JwtAuthGuard`: deja el usuario autenticado en la petición y nada más.
     * Se registra ANTES que `PermissionsGuard` porque ese es el orden real de la aplicación, y
     * es justo lo que esta prueba necesita que se cumpla.
     */
    class StubAuthGuard implements CanActivate {
      canActivate(context: ExecutionContext): boolean {
        context.switchToHttp().getRequest().user = { sub: USER_ID };
        return true;
      }
    }

    const accountRepository = {
      findOne: jest.fn(async () =>
        activeRole ? MEMBERSHIPS[activeRole] : null,
      ),
    };

    const rolesService = {
      getPermissionScopes: jest.fn(
        async (
          roleId: SYSTEM_ROLE_NAME_ENUM,
          resource: RESOURCE_KEY_ENUM,
          action: ACTION_KEY_ENUM,
        ) => scopesFromCatalog(roleId, resource, action),
      ),
    };

    const useCaseStubs = [
      CreateOrganizationUseCase,
      InviteOrganizationMemberUseCase,
      AddOrganizationMemberUseCase,
      GetOrganizationMemberListUseCase,
      UpdateAccountMemberUseCase,
      RevokeAccountAccessUseCase,
      GetMemberPermissionsUseCase,
      AssignMemberPermissionsUseCase,
      GetOrganizationPermissionsUseCase,
      CreateOrganizationPermissionUseCase,
      UpdateOrganizationPermissionUseCase,
      DeleteOrganizationPermissionUseCase,
      ListOrganizationRolesUseCase,
      CreateOrganizationRoleUseCase,
      UpdateOrganizationRoleUseCase,
      GetPublicStripePlansUseCase,
      CreateSubscriptionCheckoutUseCase,
      CreateDocumentCreditCheckoutUseCase,
      GetAvailableDocumentCreditOffersUseCase,
      CancelSubscriptionUseCase,
      ResumeSubscriptionUseCase,
      GetBillingAccessUseCase,
      ArchiveCompletedDocumentUseCase,
      SignDocumentUseCase,
    ].map((provide) => ({
      provide,
      useValue: { execute: jest.fn().mockResolvedValue({ success: true }) },
    }));

    const moduleFixture: TestingModule = await Test.createTestingModule({
      controllers: [
        OrganizationsController,
        OrganizationPermissionsController,
        OrganizationRolesController,
        PaymentsController,
        DocumentController,
      ],
      providers: [
        ...DOCUMENT_CONTROLLER_USE_CASE_STUBS,
        ...useCaseStubs,
        AuthorizationService,
        {
          provide: getRepositoryToken(AccountEntity),
          useValue: accountRepository,
        },
        { provide: RolesService, useValue: rolesService },
        { provide: APP_GUARD, useClass: StubAuthGuard },
        { provide: APP_GUARD, useClass: PermissionsGuard },
      ],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(() => {
    activeRole = SYSTEM_ROLE_NAME_ENUM.OWNER;
  });

  /** Petición con la cuenta activa del rol en curso en los headers, como la manda el frontend. */
  function get(path: string) {
    return request(app.getHttpServer())
      .get(path)
      .set('X-Account-Id', MEMBERSHIPS[activeRole!].id as string);
  }

  /**
   * Un endpoint por recurso del catálogo. Cada uno se prueba dos veces: con un rol que tiene el
   * permiso y con uno que no, porque un 200 solo no distingue "autorizó" de "no comprobó nada".
   */
  describe('un endpoint por recurso', () => {
    const endpoints: Array<[string, string, SYSTEM_ROLE_NAME_ENUM]> = [
      [
        'ORGANIZATION',
        `/organizations/${ORGANIZATION_ID}/permissions`,
        SYSTEM_ROLE_NAME_ENUM.MEMBER,
      ],
      ['BILLING', '/payments/billing-state', SYSTEM_ROLE_NAME_ENUM.MEMBER],
      [
        'MEMBER',
        `/organizations/${ORGANIZATION_ID}/members`,
        SYSTEM_ROLE_NAME_ENUM.MEMBER,
      ],
      [
        'ROLE',
        `/organizations/${ORGANIZATION_ID}/roles`,
        SYSTEM_ROLE_NAME_ENUM.MEMBER,
      ],
    ];

    it.each(endpoints)('%s: el propietario entra', async (_resource, path) => {
      activeRole = SYSTEM_ROLE_NAME_ENUM.OWNER;

      await get(path).expect(200);
    });

    it.each(endpoints)(
      '%s: un rol sin el permiso recibe 403',
      async (_resource, path, deniedRole) => {
        activeRole = deniedRole;

        await get(path).expect(403);
      },
    );

    /**
     * DOCUMENT va aparte: es el único recurso cuyo permiso SÍ tiene un MEMBER
     * (`DOCUMENT.READ_OWN`), así que el 403 no puede venir del rol. Es justamente el caso que
     * justifica el reparto en dos: el guard deja pasar a los dos roles, y cuál de ellos puede
     * ver ESTE documento lo decide después `DocumentAuthorizationPolicy`.
     */
    it('DOCUMENT: el guard deja pasar tanto al propietario como al miembro raso', async () => {
      activeRole = SYSTEM_ROLE_NAME_ENUM.OWNER;
      await get('/document/doc-1').expect(200);

      activeRole = SYSTEM_ROLE_NAME_ENUM.MEMBER;
      await get('/document/doc-1').expect(200);
    });
  });

  describe('contexto de autorización', () => {
    /**
     * El contexto no es un detalle interno del guard: es lo que el caso de uso recibe para poder
     * decidir. Que llegue con los scopes del rol —y no con los de otro— es lo que hace posible
     * que un miembro raso y un propietario vean cosas distintas del mismo documento.
     */
    it('llega al controller con el rol, la cuenta y los scopes de la membresía activa', async () => {
      activeRole = SYSTEM_ROLE_NAME_ENUM.MEMBER;
      const getDocument = app.get(GetDocumentUseCase) as unknown as {
        execute: jest.Mock;
      };

      await get('/document/doc-1').expect(200);

      expect(getDocument.execute).toHaveBeenCalledWith({
        documentId: 'doc-1',
        authorization: {
          userId: USER_ID,
          organizationId: ORGANIZATION_ID,
          accountId: 'account-member',
          roleId: SYSTEM_ROLE_NAME_ENUM.MEMBER,
          resource: RESOURCE_KEY_ENUM.DOCUMENT,
          action: ACTION_KEY_ENUM.READ,
          scopes: [PERMISSION_SCOPE_ENUM.OWN],
        },
      });
    });

    it('el propietario recibe además el alcance de organización sobre los mismos documentos', async () => {
      activeRole = SYSTEM_ROLE_NAME_ENUM.OWNER;
      const getDocument = app.get(GetDocumentUseCase) as unknown as {
        execute: jest.Mock;
      };
      getDocument.execute.mockClear();

      await get('/document/doc-1').expect(200);

      expect(getDocument.execute).toHaveBeenCalledWith(
        expect.objectContaining({
          authorization: expect.objectContaining({
            scopes: [
              PERMISSION_SCOPE_ENUM.OWN,
              PERMISSION_SCOPE_ENUM.ORGANIZATION,
            ],
          }),
        }),
      );
    });
  });

  describe('migración incremental', () => {
    /**
     * El catálogo de planes no declara permiso y sigue contestando. Es lo que permite anotar los
     * controllers de a poco: lo que todavía no se migró no se rompe.
     */
    it('un endpoint sin @RequirePermission no se bloquea, ni siquiera sin cuenta activa', async () => {
      await request(app.getHttpServer()).get('/payments/services').expect(200);
    });
  });

  describe('membresía', () => {
    it('sin cuenta activa en los headers, un endpoint protegido responde 403', async () => {
      await request(app.getHttpServer())
        .get('/payments/billing-state')
        .expect(403);
    });

    it('sin membresía activa en esa organización, responde 403', async () => {
      activeRole = SYSTEM_ROLE_NAME_ENUM.OWNER;

      await request(app.getHttpServer())
        .get(`/organizations/${ORGANIZATION_ID}/roles`)
        .set('X-Account-Id', 'account-owner')
        .expect(200);

      activeRole = null;

      await request(app.getHttpServer())
        .get(`/organizations/${ORGANIZATION_ID}/roles`)
        .set('X-Account-Id', 'account-owner')
        .expect(403);
    });
  });
});
