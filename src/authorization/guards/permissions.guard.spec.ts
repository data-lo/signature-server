import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { ACTION_KEY_ENUM } from 'src/roles/enums/action-key.enum';
import { PERMISSION_SCOPE_ENUM } from 'src/roles/enums/permission-scope.enum';
import { RESOURCE_KEY_ENUM } from 'src/roles/enums/resource-key.enum';

import { REQUIRED_PERMISSION_METADATA } from '../constants/permission-metadata.constant';
import { AuthorizationContext } from '../interfaces/authorization-context.interface';
import { AuthorizationService } from '../services/authorization.service';
import { PermissionsGuard } from './permissions.guard';

/**
 * El guard se prueba con `AuthorizationService` doblado: lo suyo es leer el metadato, sacar de la
 * petición al usuario y la cuenta activa, delegar y dejar el contexto donde el controller pueda
 * recogerlo. Que la membresía y los permisos se resuelvan bien es de `AuthorizationService`, y
 * tiene su propia prueba.
 */
describe('PermissionsGuard', () => {
  const REQUIRED = {
    resource: RESOURCE_KEY_ENUM.DOCUMENT,
    action: ACTION_KEY_ENUM.READ,
  };

  const AUTHORIZED: AuthorizationContext = {
    userId: 'user-1',
    organizationId: 'org-1',
    accountId: 'account-1',
    roleId: 'role-1',
    resource: RESOURCE_KEY_ENUM.DOCUMENT,
    action: ACTION_KEY_ENUM.READ,
    scopes: [PERMISSION_SCOPE_ENUM.OWN],
  };

  let reflector: { getAllAndOverride: jest.Mock };
  let authorizationService: { authorize: jest.Mock };
  let guard: PermissionsGuard;

  beforeEach(() => {
    reflector = { getAllAndOverride: jest.fn().mockReturnValue(REQUIRED) };
    authorizationService = {
      authorize: jest.fn().mockResolvedValue(AUTHORIZED),
    };

    guard = new PermissionsGuard(
      reflector as unknown as Reflector,
      authorizationService as unknown as AuthorizationService,
    );
  });

  /** Petición mínima con la forma que Express le da a Nest. */
  function buildRequest(overrides: Record<string, unknown> = {}) {
    return {
      user: { sub: 'user-1' },
      params: {},
      headers: { 'x-account-id': 'account-1' },
      ...overrides,
    };
  }

  /**
   * `handler` y `controller` se crean UNA vez y se devuelven siempre los mismos. Si
   * `getHandler()` fabricara una función nueva en cada llamada, la prueba que comprueba con qué
   * los buscó el `Reflector` compararía dos referencias distintas y nunca podría pasar.
   */
  function buildContext(request: Record<string, unknown>): ExecutionContext {
    const handler = function handler() {};
    const controller = class Controller {};

    return {
      switchToHttp: () => ({ getRequest: () => request }),
      getHandler: () => handler,
      getClass: () => controller,
    } as unknown as ExecutionContext;
  }

  it('permite endpoints sin @RequirePermission, sin consultar nada', async () => {
    reflector.getAllAndOverride.mockReturnValue(undefined);
    const request = buildRequest();

    await expect(guard.canActivate(buildContext(request))).resolves.toBe(true);

    expect(authorizationService.authorize).not.toHaveBeenCalled();
    expect(request).not.toHaveProperty('authorization');
  });

  it('lee el permiso declarado del handler y de la clase', async () => {
    const context = buildContext(buildRequest());

    await guard.canActivate(context);

    expect(reflector.getAllAndOverride).toHaveBeenCalledWith(
      REQUIRED_PERMISSION_METADATA,
      [context.getHandler(), context.getClass()],
    );
  });

  it('rechaza una petición sin usuario autenticado', async () => {
    const context = buildContext(buildRequest({ user: undefined }));

    await expect(guard.canActivate(context)).rejects.toThrow(
      ForbiddenException,
    );
    expect(authorizationService.authorize).not.toHaveBeenCalled();
  });

  it('rechaza una petición sin organización ni cuenta activa', async () => {
    const context = buildContext(buildRequest({ headers: {} }));

    await expect(guard.canActivate(context)).rejects.toThrow(
      ForbiddenException,
    );
    expect(authorizationService.authorize).not.toHaveBeenCalled();
  });

  /**
   * Las tres razones por las que `AuthorizationService` rechaza —sin membresía activa, sin rol,
   * o con un rol sin el permiso— llegan al cliente tal cual, sin envolverse en otro error: el
   * mensaje de cada una dice algo distinto y perderlo dejaría un 403 mudo.
   */
  it.each([
    ['sin membresía activa', 'No tienes una membresía activa en esta cuenta'],
    [
      'sin rol asignado',
      'Tu membresía no tiene un rol asignado en esta cuenta',
    ],
    [
      'sin el permiso requerido',
      'No tienes permisos suficientes para realizar esta acción',
    ],
  ])('propaga el 403 de una membresía %s', async (_case, message) => {
    authorizationService.authorize.mockRejectedValue(
      new ForbiddenException(message),
    );
    const context = buildContext(buildRequest());

    await expect(guard.canActivate(context)).rejects.toThrow(message);
  });

  it('permite a un rol con el permiso requerido y adjunta el contexto con sus scopes', async () => {
    const request = buildRequest();

    await expect(guard.canActivate(buildContext(request))).resolves.toBe(true);

    expect(authorizationService.authorize).toHaveBeenCalledWith({
      userId: 'user-1',
      organizationId: undefined,
      accountId: 'account-1',
      resource: RESOURCE_KEY_ENUM.DOCUMENT,
      action: ACTION_KEY_ENUM.READ,
    });
    expect((request as Record<string, unknown>).authorization).toEqual(
      AUTHORIZED,
    );
  });

  describe('resolución de la cuenta activa', () => {
    it('prefiere el :organizationId de la ruta sobre los headers', async () => {
      const request = buildRequest({
        params: { organizationId: 'org-de-la-ruta' },
        headers: {
          'x-account-id': 'account-1',
          'x-organization-id': 'org-del-header',
        },
      });

      await guard.canActivate(buildContext(request));

      expect(authorizationService.authorize).toHaveBeenCalledWith(
        expect.objectContaining({ organizationId: 'org-de-la-ruta' }),
      );
    });

    it('usa X-Organization-Id cuando la ruta no lleva la organización', async () => {
      const request = buildRequest({
        headers: {
          'x-account-id': 'account-1',
          'x-organization-id': 'org-del-header',
        },
      });

      await guard.canActivate(buildContext(request));

      expect(authorizationService.authorize).toHaveBeenCalledWith(
        expect.objectContaining({
          organizationId: 'org-del-header',
          accountId: 'account-1',
        }),
      );
    });
  });
});
