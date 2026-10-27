import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { ACTION_KEY_ENUM } from 'src/roles/enums/action-key.enum';
import { PERMISSION_SCOPE_ENUM } from 'src/roles/enums/permission-scope.enum';
import { RESOURCE_KEY_ENUM } from 'src/roles/enums/resource-key.enum';

import { RequiredApiKeyPermission } from '../decorators/require-api-key-permission.decorator';
import {
  ApiKeyPermissionDeniedException,
  InvalidApiKeyException,
} from '../exceptions/api-key.exceptions';
import { IntegrationApiClient } from '../interfaces/integration-api-client.interface';
import { ApiKeyPermissionGuard } from './api-key-permission.guard';

describe('ApiKeyPermissionGuard', () => {
  let required: RequiredApiKeyPermission | undefined;
  let guard: ApiKeyPermissionGuard;

  function apiClient(
    permissions: IntegrationApiClient['permissions'],
  ): IntegrationApiClient {
    return {
      apiKeyId: 'key-1',
      apiKeyName: 'ERP',
      organizationId: 'org-1',
      actorAccountId: 'acc-1',
      actorUserId: 'user-1',
      permissions,
    };
  }

  function context(request: Record<string, unknown>): ExecutionContext {
    return {
      switchToHttp: () => ({ getRequest: () => request }),
      getHandler: () => undefined,
      getClass: () => undefined,
    } as unknown as ExecutionContext;
  }

  const READ_ORG = {
    resource: RESOURCE_KEY_ENUM.DOCUMENT,
    action: ACTION_KEY_ENUM.READ,
    scope: PERMISSION_SCOPE_ENUM.ORGANIZATION,
  };
  const READ_OWN = { ...READ_ORG, scope: PERMISSION_SCOPE_ENUM.OWN };

  beforeEach(() => {
    required = {
      resource: RESOURCE_KEY_ENUM.DOCUMENT,
      action: ACTION_KEY_ENUM.READ,
      scopes: [PERMISSION_SCOPE_ENUM.ORGANIZATION],
    };
    guard = new ApiKeyPermissionGuard({
      getAllAndOverride: () => required,
    } as unknown as Reflector);
  });

  it('deja pasar la llave que tiene el permiso con un alcance admitido', () => {
    expect(
      guard.canActivate(context({ apiClient: apiClient([READ_ORG]) })),
    ).toBe(true);
  });

  it('acepta cualquiera de los alcances declarados', () => {
    required!.scopes = [
      PERMISSION_SCOPE_ENUM.OWN,
      PERMISSION_SCOPE_ENUM.ORGANIZATION,
    ];
    expect(
      guard.canActivate(context({ apiClient: apiClient([READ_OWN]) })),
    ).toBe(true);
  });

  it('403 si la llave sólo tiene OWN y el endpoint exige ORGANIZATION', () => {
    expect(() =>
      guard.canActivate(context({ apiClient: apiClient([READ_OWN]) })),
    ).toThrow(ApiKeyPermissionDeniedException);
  });

  it('falla cerrado: 403 en una ruta sin permiso declarado', () => {
    required = undefined;
    expect(() =>
      guard.canActivate(context({ apiClient: apiClient([READ_ORG]) })),
    ).toThrow(ApiKeyPermissionDeniedException);
  });

  it('401 sin cliente resuelto (falta OrganizationApiKeyGuard antes)', () => {
    expect(() => guard.canActivate(context({}))).toThrow(
      InvalidApiKeyException,
    );
  });

  it('los permisos salen del cliente resuelto, no de lo que mande la petición', () => {
    expect(() =>
      guard.canActivate(
        context({
          apiClient: apiClient([READ_OWN]),
          body: { permissions: [READ_ORG] },
          query: { scope: 'ORGANIZATION' },
        }),
      ),
    ).toThrow(ApiKeyPermissionDeniedException);
  });
});
