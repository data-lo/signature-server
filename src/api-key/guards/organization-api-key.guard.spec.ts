import { ExecutionContext } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { Repository } from 'typeorm';

import { AccountEntity } from 'src/account/entities/account.entity';
import { ACTION_KEY_ENUM } from 'src/roles/enums/action-key.enum';
import { PERMISSION_SCOPE_ENUM } from 'src/roles/enums/permission-scope.enum';
import { RESOURCE_KEY_ENUM } from 'src/roles/enums/resource-key.enum';

import { ApiKeySecretService } from '../api-key-secret.service';
import { RequiredApiKeyPermission } from '../decorators/require-api-key-permission.decorator';
import { ApiKeyEntity } from '../entities/api-key.entity';
import { ApiKeyStatusEnum } from '../enums/api-key-status.enum';
import {
  ApiKeyActorInactiveException,
  ApiKeyOrganizationInactiveException,
  ApiKeyPermissionDeniedException,
  ExpiredApiKeyException,
  InvalidApiKeyException,
} from '../exceptions/api-key.exceptions';
import {
  hasApiKeyPermission,
  OrganizationApiKeyGuard,
} from './organization-api-key.guard';

const PEPPER = 'pepper-de-prueba-con-al-menos-treinta-y-dos-caracteres';

describe('OrganizationApiKeyGuard', () => {
  const secrets = new ApiKeySecretService({
    get: () => PEPPER,
  } as unknown as ConfigService);
  const issued = secrets.generate();

  let apiKeyRepository: { findOne: jest.Mock; update: jest.Mock };
  let accountRepository: { findOne: jest.Mock };
  let required: RequiredApiKeyPermission | undefined;
  let guard: OrganizationApiKeyGuard;

  function permission(resource: string, action: string, scope: string) {
    return {
      id: `perm-${resource}-${action}-${scope}`,
      scope,
      resource: { key: resource },
      action: { key: action },
    };
  }

  function storedKey(overrides: Partial<ApiKeyEntity> = {}): ApiKeyEntity {
    return {
      id: 'key-1',
      name: 'Integración ERP',
      organizationId: 'org-1',
      createdByAccountId: 'account-actor',
      publicId: issued.publicId,
      keyPrefix: issued.keyPrefix,
      secretHash: issued.secretHash,
      status: ApiKeyStatusEnum.ACTIVE,
      expiresAt: null,
      organization: { id: 'org-1', isActive: true },
      permissions: [permission('DOCUMENT', 'READ', 'ORGANIZATION')],
      ...overrides,
    } as unknown as ApiKeyEntity;
  }

  function context(headers: Record<string, unknown>) {
    const request: Record<string, unknown> = { headers };
    return {
      request,
      ctx: {
        switchToHttp: () => ({ getRequest: () => request }),
        getHandler: () => undefined,
        getClass: () => undefined,
      } as unknown as ExecutionContext,
    };
  }

  beforeEach(() => {
    apiKeyRepository = {
      findOne: jest.fn().mockResolvedValue(storedKey()),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    accountRepository = {
      findOne: jest
        .fn()
        .mockResolvedValue({ id: 'account-actor', userId: 'user-actor' }),
    };
    required = {
      resource: RESOURCE_KEY_ENUM.DOCUMENT,
      action: ACTION_KEY_ENUM.READ,
      scopes: [PERMISSION_SCOPE_ENUM.ORGANIZATION],
    };
    guard = new OrganizationApiKeyGuard(
      { getAllAndOverride: () => required } as unknown as Reflector,
      apiKeyRepository as unknown as Repository<ApiKeyEntity>,
      accountRepository as unknown as Repository<AccountEntity>,
      secrets,
    );
  });

  it('autentica la llave y deja el cliente en la petición, sin secreto ni hash', async () => {
    const { request, ctx } = context({ 'x-api-key': issued.key });

    await expect(guard.canActivate(ctx)).resolves.toBe(true);

    expect(apiKeyRepository.findOne).toHaveBeenCalledWith(
      expect.objectContaining({ where: { publicId: issued.publicId } }),
    );
    expect(accountRepository.findOne).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'account-actor', organizationId: 'org-1', isActive: true },
      }),
    );
    expect(request.apiClient).toEqual({
      apiKeyId: 'key-1',
      apiKeyName: 'Integración ERP',
      organizationId: 'org-1',
      actorAccountId: 'account-actor',
      actorUserId: 'user-actor',
      permissions: [
        { resource: 'DOCUMENT', action: 'READ', scope: 'ORGANIZATION' },
      ],
    });
    expect(JSON.stringify(request.apiClient)).not.toContain(issued.secretHash);
    expect(apiKeyRepository.update).toHaveBeenCalledWith('key-1', {
      lastUsedAt: expect.any(Date),
    });
  });

  it.each([
    ['sin header', {}],
    [
      'con un valor que no es una llave',
      { 'x-api-key': 'una-llave-cualquiera' },
    ],
    [
      'con la llave interna del .env',
      { 'x-api-key': 'replace-with-a-long-random-string' },
    ],
  ])(
    'rechaza con 401 API_KEY_INVALID %s, sin consultar la base',
    async (_label, headers) => {
      await expect(
        guard.canActivate(context(headers).ctx),
      ).rejects.toBeInstanceOf(InvalidApiKeyException);
      expect(apiKeyRepository.findOne).not.toHaveBeenCalled();
    },
  );

  it('rechaza con 401 un publicId que no existe', async () => {
    apiKeyRepository.findOne.mockResolvedValue(null);

    await expect(
      guard.canActivate(context({ 'x-api-key': issued.key }).ctx),
    ).rejects.toBeInstanceOf(InvalidApiKeyException);
  });

  it('rechaza con 401 un secreto que no coincide con el hash', async () => {
    const forged = `${issued.keyPrefix}_${'A'.repeat(43)}`;

    await expect(
      guard.canActivate(context({ 'x-api-key': forged }).ctx),
    ).rejects.toBeInstanceOf(InvalidApiKeyException);
    expect(accountRepository.findOne).not.toHaveBeenCalled();
  });

  it('rechaza con 401 una llave revocada', async () => {
    apiKeyRepository.findOne.mockResolvedValue(
      storedKey({ status: ApiKeyStatusEnum.REVOKED }),
    );

    await expect(
      guard.canActivate(context({ 'x-api-key': issued.key }).ctx),
    ).rejects.toBeInstanceOf(InvalidApiKeyException);
  });

  it('rechaza con 401 API_KEY_EXPIRED una llave vencida', async () => {
    apiKeyRepository.findOne.mockResolvedValue(
      storedKey({ expiresAt: new Date(Date.now() - 1000) }),
    );

    await expect(
      guard.canActivate(context({ 'x-api-key': issued.key }).ctx),
    ).rejects.toBeInstanceOf(ExpiredApiKeyException);
  });

  it('rechaza con 403 si la organización está desactivada', async () => {
    apiKeyRepository.findOne.mockResolvedValue(
      storedKey({ organization: { id: 'org-1', isActive: false } as never }),
    );

    await expect(
      guard.canActivate(context({ 'x-api-key': issued.key }).ctx),
    ).rejects.toBeInstanceOf(ApiKeyOrganizationInactiveException);
  });

  it('rechaza con 403 si el actor ya no es miembro activo de la organización', async () => {
    accountRepository.findOne.mockResolvedValue(null);

    await expect(
      guard.canActivate(context({ 'x-api-key': issued.key }).ctx),
    ).rejects.toBeInstanceOf(ApiKeyActorInactiveException);
  });

  it('rechaza con 403 si la llave sólo tiene OWN y el endpoint exige ORGANIZATION', async () => {
    apiKeyRepository.findOne.mockResolvedValue(
      storedKey({
        permissions: [permission('DOCUMENT', 'READ', 'OWN')] as never,
      }),
    );

    await expect(
      guard.canActivate(context({ 'x-api-key': issued.key }).ctx),
    ).rejects.toBeInstanceOf(ApiKeyPermissionDeniedException);
    expect(apiKeyRepository.update).not.toHaveBeenCalled();
  });

  it('un fallo al marcar el último uso no rechaza la petición', async () => {
    apiKeyRepository.update.mockRejectedValue(new Error('base ocupada'));

    await expect(
      guard.canActivate(context({ 'x-api-key': issued.key }).ctx),
    ).resolves.toBe(true);
  });

  describe('hasApiKeyPermission', () => {
    const read = (scopes: PERMISSION_SCOPE_ENUM[]) => ({
      resource: RESOURCE_KEY_ENUM.DOCUMENT,
      action: ACTION_KEY_ENUM.READ,
      scopes,
    });
    const granted = (scope: PERMISSION_SCOPE_ENUM) => [
      {
        resource: RESOURCE_KEY_ENUM.DOCUMENT,
        action: ACTION_KEY_ENUM.READ,
        scope,
      },
    ];

    it('acepta un alcance de los declarados', () => {
      expect(
        hasApiKeyPermission(
          granted(PERMISSION_SCOPE_ENUM.OWN),
          read([PERMISSION_SCOPE_ENUM.OWN, PERMISSION_SCOPE_ENUM.ORGANIZATION]),
        ),
      ).toBe(true);
    });

    it('ANY satisface cualquier alcance', () => {
      expect(
        hasApiKeyPermission(
          granted(PERMISSION_SCOPE_ENUM.ANY),
          read([PERMISSION_SCOPE_ENUM.ORGANIZATION]),
        ),
      ).toBe(true);
    });

    it('otra acción o recurso no cuenta', () => {
      expect(
        hasApiKeyPermission(
          [
            {
              resource: RESOURCE_KEY_ENUM.DOCUMENT,
              action: ACTION_KEY_ENUM.CREATE,
              scope: PERMISSION_SCOPE_ENUM.ANY,
            },
          ],
          read([PERMISSION_SCOPE_ENUM.ORGANIZATION]),
        ),
      ).toBe(false);
    });
  });
});
