import { ConfigService } from '@nestjs/config';

import { ApiKeySecretService } from '../api-key-secret.service';
import { ApiKeyStatusEnum } from '../enums/api-key-status.enum';
import {
  ApiKeyPermissionNotAllowedException,
  ApiKeyPermissionNotFoundException,
} from '../exceptions/api-key.exceptions';
import { IssuePlatformApiKeyUseCase } from './issue-platform-api-key.use-case';

const PEPPER = 'pepper-de-prueba-con-al-menos-treinta-y-dos-caracteres';

function permission(resource: string, action: string, scope: string) {
  return {
    id: `perm-${resource}-${action}-${scope}`,
    scope,
    resource: { key: resource },
    action: { key: action },
  };
}

describe('IssuePlatformApiKeyUseCase', () => {
  const secrets = new ApiKeySecretService({
    get: () => PEPPER,
  } as unknown as ConfigService);

  let apiKeyService: {
    findPermissionsByKeys: jest.Mock;
    insertApiKey: jest.Mock;
  };
  let useCase: IssuePlatformApiKeyUseCase;

  beforeEach(() => {
    apiKeyService = {
      findPermissionsByKeys: jest
        .fn()
        .mockResolvedValue([
          permission('DOCUMENT', 'CREATE', 'ANY'),
          permission('DIRECTORY', 'READ', 'ANY'),
        ]),
      insertApiKey: jest.fn(async (_manager, apiKey) => ({
        id: 'key-1',
        createdAt: new Date(),
        ...apiKey,
      })),
    };
    useCase = new IssuePlatformApiKeyUseCase(apiKeyService as never, secrets);
  });

  describe('resolvePermissionProfile', () => {
    it('carga el perfil por sus claves', async () => {
      const result = await useCase.resolvePermissionProfile([
        'DOCUMENT.CREATE',
        'DIRECTORY.READ',
      ]);

      expect(apiKeyService.findPermissionsByKeys).toHaveBeenCalledWith([
        'DOCUMENT.CREATE',
        'DIRECTORY.READ',
      ]);
      expect(result.map((item) => item.id)).toEqual([
        'perm-DOCUMENT-CREATE-ANY',
        'perm-DIRECTORY-READ-ANY',
      ]);
    });

    it('rechaza con 422 un permiso administrativo sin consultar el catálogo', async () => {
      await expect(
        useCase.resolvePermissionProfile(['DOCUMENT.CREATE', 'MEMBER.INVITE']),
      ).rejects.toBeInstanceOf(ApiKeyPermissionNotAllowedException);
      expect(apiKeyService.findPermissionsByKeys).not.toHaveBeenCalled();
    });

    it('rechaza con 422 un permiso que el catálogo no tiene sembrado', async () => {
      await expect(
        useCase.resolvePermissionProfile([
          'DOCUMENT.CREATE',
          'DIRECTORY.READ',
          'DOCUMENT.CANCEL',
        ]),
      ).rejects.toBeInstanceOf(ApiKeyPermissionNotFoundException);
    });
  });

  it('emite una llave ACTIVE sin emisor ni vencimiento y devuelve la llave una vez', async () => {
    const manager = { create: jest.fn((_entity, data) => data) };
    const permissions = [permission('DOCUMENT', 'CREATE', 'ANY')];

    const issued = await useCase.issueWithin(manager as never, {
      organizationId: 'org-1',
      name: 'Integración Enterprise Acme',
      permissions: permissions as never,
    });

    const [, saved] = apiKeyService.insertApiKey.mock.calls[0];
    expect(saved).toEqual(
      expect.objectContaining({
        organizationId: 'org-1',
        createdByAccountId: null,
        status: ApiKeyStatusEnum.ACTIVE,
        expiresAt: null,
        permissions,
      }),
    );
    expect(saved.secretHash).not.toContain(issued.key.split('_').pop());
    expect(issued.key).toMatch(/^fma_live_[0-9a-f]{16}_[A-Za-z0-9_-]{43}$/);
    expect(issued.createdByAccountId).toBeNull();
  });
});
