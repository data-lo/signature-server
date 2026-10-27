import { QueryFailedError } from 'typeorm';

import { OrganizationEntity } from 'src/account/entities/organization.entity';
import { AuthorizationContext } from 'src/authorization/interfaces/authorization-context.interface';
import { PermissionEntity } from 'src/roles/entities/permission.entity';
import { ACTION_KEY_ENUM } from 'src/roles/enums/action-key.enum';
import { PERMISSION_SCOPE_ENUM } from 'src/roles/enums/permission-scope.enum';
import { RESOURCE_KEY_ENUM } from 'src/roles/enums/resource-key.enum';

import { ApiKeySecretService } from '../api-key-secret.service';
import { ApiKeyService } from '../api-key.service';
import { ApiKeyEntity } from '../entities/api-key.entity';
import { ApiKeyStatusEnum } from '../enums/api-key-status.enum';
import {
  ApiKeyAlreadyActiveException,
  ApiKeyInvalidExpirationException,
  ApiKeyNotFoundException,
  ApiKeyOrganizationNotFoundException,
  ApiKeyPermissionNotAllowedException,
  ApiKeyPermissionNotFoundException,
  ApiKeyRotationConflictException,
} from '../exceptions/api-key.exceptions';
import { CreateOrganizationApiKeyUseCase } from './create-organization-api-key.use-case';
import { GetCurrentOrganizationApiKeyUseCase } from './get-current-organization-api-key.use-case';
import { ListOrganizationApiKeysUseCase } from './list-organization-api-keys.use-case';
import { OrganizationApiKeyActor } from './organization-api-key.shared';
import { RevokeOrganizationApiKeyUseCase } from './revoke-organization-api-key.use-case';
import { RotateOrganizationApiKeyUseCase } from './rotate-organization-api-key.use-case';

const ORGANIZATION_ID = 'org-1';
const FUTURE = '2999-01-01T00:00:00.000Z';

function authorization(accountId = 'account-owner'): AuthorizationContext {
  return {
    userId: `user-${accountId}`,
    organizationId: ORGANIZATION_ID,
    accountId,
    roleId: 'role-owner',
    resource: RESOURCE_KEY_ENUM.API_KEY,
    action: ACTION_KEY_ENUM.MANAGE,
    scopes: [PERMISSION_SCOPE_ENUM.ANY],
  };
}

function actor(accountId?: string): OrganizationApiKeyActor {
  return {
    organizationId: ORGANIZATION_ID,
    authorization: authorization(accountId),
  };
}

function permission(
  id: string,
  resource: string,
  action: string,
  scope = 'ANY',
): PermissionEntity {
  return {
    id,
    resourceId: `resource-${resource}`,
    actionId: `action-${action}`,
    scope,
    resource: { id: `resource-${resource}`, key: resource, description: '' },
    action: { id: `action-${action}`, key: action, description: '' },
  } as PermissionEntity;
}

const documentCreate = permission('perm-doc-create', 'DOCUMENT', 'CREATE');
const directoryRead = permission('perm-dir-read', 'DIRECTORY', 'READ');
const memberInvite = permission('perm-member-invite', 'MEMBER', 'INVITE');

function apiKey(overrides: Partial<ApiKeyEntity> = {}): ApiKeyEntity {
  return {
    id: 'key-1',
    organizationId: ORGANIZATION_ID,
    createdByAccountId: 'account-owner',
    publicId: 'publicid1',
    keyPrefix: 'fma_live_publicid1',
    secretHash: 'hash-secreto',
    name: 'Integración ERP',
    status: ApiKeyStatusEnum.ACTIVE,
    createdAt: new Date('2026-10-26T12:00:00.000Z'),
    lastUsedAt: null,
    expiresAt: null,
    revokedAt: null,
    revokedByAccountId: null,
    permissions: [documentCreate],
    ...overrides,
  } as ApiKeyEntity;
}

/** Driver error de Postgres envuelto como lo lanza TypeORM. */
function driverError(code: string, constraint?: string): QueryFailedError {
  const error = new QueryFailedError('query', [], new Error('driver'));
  Object.assign(error, { driverError: { code, constraint } });
  return error;
}

describe('casos de uso de API keys de organización', () => {
  const manager = {
    create: jest.fn((_entity: unknown, data: object) => ({ ...data })),
  };
  let service: jest.Mocked<ApiKeyService>;
  let secrets: jest.Mocked<ApiKeySecretService>;

  beforeEach(() => {
    service = {
      transaction: jest.fn((work) => work(manager)),
      findActiveOrganization: jest
        .fn()
        .mockResolvedValue({ id: ORGANIZATION_ID } as OrganizationEntity),
      lockActiveOrganization: jest
        .fn()
        .mockResolvedValue({ id: ORGANIZATION_ID } as OrganizationEntity),
      findPermissionsByIds: jest.fn(async (ids: string[]) =>
        [documentCreate, directoryRead, memberInvite].filter((p) =>
          ids.includes(p.id),
        ),
      ),
      findActiveApiKey: jest.fn().mockResolvedValue(null),
      listApiKeys: jest.fn().mockResolvedValue([]),
      findApiKey: jest.fn(),
      lockApiKey: jest.fn(),
      insertApiKey: jest.fn(async (_manager, entity: ApiKeyEntity) => ({
        ...entity,
        id: 'key-new',
        createdAt: new Date('2026-10-27T12:00:00.000Z'),
      })),
      markRevoked: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<ApiKeyService>;

    secrets = {
      generate: jest.fn().mockReturnValue({
        publicId: 'newpublic',
        keyPrefix: 'fma_live_newpublic',
        key: 'fma_live_newpublic_secreto-en-claro',
        secretHash: 'hash-nuevo',
      }),
    } as unknown as jest.Mocked<ApiKeySecretService>;
  });

  describe('CreateOrganizationApiKeyUseCase', () => {
    const useCase = () => new CreateOrganizationApiKeyUseCase(service, secrets);

    it('emite la llave sin una activa, guarda sólo el hash y devuelve el secreto una vez', async () => {
      const { data } = await useCase().execute(actor(), {
        name: 'Integración ERP',
        permissionIds: [documentCreate.id, directoryRead.id],
        expiresAt: FUTURE,
      });

      expect(service.lockActiveOrganization).toHaveBeenCalledWith(
        manager,
        ORGANIZATION_ID,
        'wait',
      );
      const inserted = service.insertApiKey.mock.calls[0][1];
      expect(inserted).toMatchObject({
        organizationId: ORGANIZATION_ID,
        createdByAccountId: 'account-owner',
        secretHash: 'hash-nuevo',
        status: ApiKeyStatusEnum.ACTIVE,
        expiresAt: new Date(FUTURE),
      });
      expect(JSON.stringify(inserted)).not.toContain('secreto-en-claro');
      expect(data).toMatchObject({
        id: 'key-new',
        prefix: 'fma_live_newpublic',
        key: 'fma_live_newpublic_secreto-en-claro',
        status: ApiKeyStatusEnum.ACTIVE,
        permissions: [
          { id: documentCreate.id, key: 'DOCUMENT.CREATE' },
          { id: directoryRead.id, key: 'DIRECTORY.READ' },
        ],
      });
      expect(data).not.toHaveProperty('secretHash');
    });

    it('responde 409 si la organización ya tiene una llave activa', async () => {
      service.findActiveApiKey.mockResolvedValue(apiKey());

      await expect(
        useCase().execute(actor(), {
          name: 'ERP',
          permissionIds: [documentCreate.id],
        }),
      ).rejects.toBeInstanceOf(ApiKeyAlreadyActiveException);
      expect(service.insertApiKey).not.toHaveBeenCalled();
    });

    it('traduce el choque con el índice parcial a 409', async () => {
      service.insertApiKey.mockRejectedValue(
        driverError('23505', 'uq_api_keys_one_active_per_organization'),
      );

      await expect(
        useCase().execute(actor(), {
          name: 'ERP',
          permissionIds: [documentCreate.id],
        }),
      ).rejects.toBeInstanceOf(ApiKeyAlreadyActiveException);
    });

    it('responde 422 si algún permiso no existe', async () => {
      await expect(
        useCase().execute(actor(), {
          name: 'ERP',
          permissionIds: [documentCreate.id, 'perm-inexistente'],
        }),
      ).rejects.toBeInstanceOf(ApiKeyPermissionNotFoundException);
      expect(service.transaction).not.toHaveBeenCalled();
    });

    it('responde 422 si algún permiso no se puede conceder a una API key', async () => {
      await expect(
        useCase().execute(actor(), {
          name: 'ERP',
          permissionIds: [documentCreate.id, memberInvite.id],
        }),
      ).rejects.toBeInstanceOf(ApiKeyPermissionNotAllowedException);
    });

    it('responde 422 si la expiración no es futura', async () => {
      await expect(
        useCase().execute(actor(), {
          name: 'ERP',
          permissionIds: [documentCreate.id],
          expiresAt: '2000-01-01T00:00:00.000Z',
        }),
      ).rejects.toBeInstanceOf(ApiKeyInvalidExpirationException);
    });

    it('responde 404 si la organización está desactivada', async () => {
      service.lockActiveOrganization.mockResolvedValue(null);

      await expect(
        useCase().execute(actor(), {
          name: 'ERP',
          permissionIds: [documentCreate.id],
        }),
      ).rejects.toBeInstanceOf(ApiKeyOrganizationNotFoundException);
    });
  });

  describe('ListOrganizationApiKeysUseCase', () => {
    it('devuelve el historial sin secreto ni hash', async () => {
      service.listApiKeys.mockResolvedValue([
        apiKey({ id: 'key-2' }),
        apiKey({
          id: 'key-1',
          status: ApiKeyStatusEnum.REVOKED,
          revokedAt: new Date(),
          revokedByAccountId: 'account-admin',
        }),
      ]);

      const { data } = await new ListOrganizationApiKeysUseCase(
        service,
      ).execute(actor());

      expect(data?.map((item) => [item.id, item.status])).toEqual([
        ['key-2', ApiKeyStatusEnum.ACTIVE],
        ['key-1', ApiKeyStatusEnum.REVOKED],
      ]);
      expect(JSON.stringify(data)).not.toMatch(
        /secretHash|hash-secreto|"key":"fma/,
      );
    });

    it('responde 404 si la organización está desactivada', async () => {
      service.findActiveOrganization.mockResolvedValue(null);

      await expect(
        new ListOrganizationApiKeysUseCase(service).execute(actor()),
      ).rejects.toBeInstanceOf(ApiKeyOrganizationNotFoundException);
    });
  });

  describe('GetCurrentOrganizationApiKeyUseCase', () => {
    it('devuelve la llave vigente sin secreto', async () => {
      service.findActiveApiKey.mockResolvedValue(apiKey());

      const { data } = await new GetCurrentOrganizationApiKeyUseCase(
        service,
      ).execute(actor());

      expect(data).toMatchObject({ id: 'key-1', prefix: 'fma_live_publicid1' });
      expect(data).not.toHaveProperty('key');
    });

    it('responde 404 API_KEY_NOT_FOUND si no hay llave activa', async () => {
      await expect(
        new GetCurrentOrganizationApiKeyUseCase(service).execute(actor()),
      ).rejects.toBeInstanceOf(ApiKeyNotFoundException);
    });
  });

  describe('RotateOrganizationApiKeyUseCase', () => {
    const useCase = () => new RotateOrganizationApiKeyUseCase(service, secrets);

    beforeEach(() => {
      service.lockApiKey.mockResolvedValue(apiKey());
      service.findApiKey.mockResolvedValue(apiKey());
    });

    it('revoca la vigente con quién y cuándo, y emite otra heredando nombre y permisos', async () => {
      const { data } = await useCase().execute(actor('account-admin'));

      expect(service.lockActiveOrganization).toHaveBeenCalledWith(
        manager,
        ORGANIZATION_ID,
        'nowait',
      );
      expect(service.lockApiKey).toHaveBeenCalledWith(
        manager,
        ORGANIZATION_ID,
        {
          status: ApiKeyStatusEnum.ACTIVE,
        },
      );
      expect(service.markRevoked).toHaveBeenCalledWith(
        manager,
        'key-1',
        'account-admin',
        expect.any(Date),
      );
      expect(service.markRevoked.mock.invocationCallOrder[0]).toBeLessThan(
        service.insertApiKey.mock.invocationCallOrder[0],
      );
      expect(service.insertApiKey.mock.calls[0][1]).toMatchObject({
        name: 'Integración ERP',
        createdByAccountId: 'account-admin',
        expiresAt: null,
        permissions: [documentCreate],
      });
      expect(data?.key).toBe('fma_live_newpublic_secreto-en-claro');
    });

    it('usa el nombre, los permisos y la expiración del body', async () => {
      await useCase().execute(actor(), {
        name: 'ERP 2027',
        permissionIds: [directoryRead.id],
        expiresAt: FUTURE,
      });

      expect(service.insertApiKey.mock.calls[0][1]).toMatchObject({
        name: 'ERP 2027',
        permissions: [directoryRead],
        expiresAt: new Date(FUTURE),
      });
    });

    it('vuelve a validar los permisos heredados contra la política', async () => {
      service.findApiKey.mockResolvedValue(
        apiKey({ permissions: [memberInvite] }),
      );

      await expect(useCase().execute(actor())).rejects.toBeInstanceOf(
        ApiKeyPermissionNotAllowedException,
      );
      expect(service.markRevoked).not.toHaveBeenCalled();
    });

    it('responde 404 si no hay llave activa que rotar', async () => {
      service.lockApiKey.mockResolvedValue(null);

      await expect(useCase().execute(actor())).rejects.toBeInstanceOf(
        ApiKeyNotFoundException,
      );
      expect(service.insertApiKey).not.toHaveBeenCalled();
    });

    it('responde 409 si otra operación tiene bloqueada la organización', async () => {
      service.lockActiveOrganization.mockRejectedValue(driverError('55P03'));

      await expect(useCase().execute(actor())).rejects.toBeInstanceOf(
        ApiKeyRotationConflictException,
      );
    });
  });

  describe('RevokeOrganizationApiKeyUseCase', () => {
    const useCase = () => new RevokeOrganizationApiKeyUseCase(service);

    it('revoca la llave activa con quién la revoca', async () => {
      service.lockApiKey.mockResolvedValue(apiKey());
      service.findApiKey.mockResolvedValue(
        apiKey({
          status: ApiKeyStatusEnum.REVOKED,
          revokedAt: new Date(),
          revokedByAccountId: 'account-admin',
        }),
      );

      const { data } = await useCase().execute(actor('account-admin'), 'key-1');

      expect(service.lockApiKey).toHaveBeenCalledWith(
        manager,
        ORGANIZATION_ID,
        {
          id: 'key-1',
        },
      );
      expect(service.markRevoked).toHaveBeenCalledWith(
        manager,
        'key-1',
        'account-admin',
        expect.any(Date),
      );
      expect(data).toMatchObject({
        status: ApiKeyStatusEnum.REVOKED,
        revokedByAccountId: 'account-admin',
      });
    });

    it('es idempotente: una llave ya revocada no se vuelve a tocar', async () => {
      const revoked = apiKey({
        status: ApiKeyStatusEnum.REVOKED,
        revokedAt: new Date('2026-10-01T00:00:00.000Z'),
        revokedByAccountId: 'account-owner',
      });
      service.lockApiKey.mockResolvedValue(revoked);
      service.findApiKey.mockResolvedValue(revoked);

      const { data } = await useCase().execute(actor('account-admin'), 'key-1');

      expect(service.markRevoked).not.toHaveBeenCalled();
      expect(data?.revokedByAccountId).toBe('account-owner');
    });

    it('responde 404 si la llave no es de la organización', async () => {
      service.lockApiKey.mockResolvedValue(null);

      await expect(
        useCase().execute(actor(), 'key-de-otra'),
      ).rejects.toBeInstanceOf(ApiKeyNotFoundException);
    });
  });
});
