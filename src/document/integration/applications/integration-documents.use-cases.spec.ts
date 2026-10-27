import { Repository } from 'typeorm';

import { AccountEntity } from 'src/account/entities/account.entity';
import { IntegrationApiClient } from 'src/api-key/interfaces/integration-api-client.interface';
import { ACTION_KEY_ENUM } from 'src/roles/enums/action-key.enum';
import { PERMISSION_SCOPE_ENUM } from 'src/roles/enums/permission-scope.enum';
import { RESOURCE_KEY_ENUM } from 'src/roles/enums/resource-key.enum';

import { DOCUMENT_STATUS_ENUM } from '../../enum/document-status.enum';
import { SIGNATURE_TYPE_ENUM } from '../../enum/signature-type.enum';
import { DocumentReadService } from '../../services/document-read.service';
import {
  IntegrationScopeDeniedException,
  IntegrationUserNotFoundException,
} from '../exceptions/integration-document.exceptions';
import { ListOrganizationIntegrationDocumentsUseCase } from './list-organization-integration-documents.use-case';
import { ListUserIntegrationDocumentsUseCase } from './list-user-integration-documents.use-case';

function apiClient(
  readScopes: PERMISSION_SCOPE_ENUM[] = [PERMISSION_SCOPE_ENUM.ORGANIZATION],
): IntegrationApiClient {
  return {
    apiKeyId: 'key-1',
    apiKeyName: 'Integración ERP',
    organizationId: 'org-1',
    actorAccountId: 'account-actor',
    actorUserId: 'user-actor',
    permissions: [
      ...readScopes.map((scope) => ({
        resource: RESOURCE_KEY_ENUM.DOCUMENT,
        action: ACTION_KEY_ENUM.READ,
        scope,
      })),
      {
        resource: RESOURCE_KEY_ENUM.DOCUMENT,
        action: ACTION_KEY_ENUM.CREATE,
        scope: PERMISSION_SCOPE_ENUM.ANY,
      },
    ],
  };
}

const PAGE = {
  items: [],
  pagination: { page: 1, limit: 25, total: 0, totalPages: 0 },
};

const SUMMARY = {
  id: 'doc-1',
  fileName: 'contrato.pdf',
  status: DOCUMENT_STATUS_ENUM.PENDING_SIGNATURE,
  signatureType: SIGNATURE_TYPE_ENUM.SIMPLE,
  createdAt: new Date('2026-10-27T12:00:00.000Z'),
  signedAt: null,
};

describe('casos de uso de la API de integración de documentos', () => {
  let documentReadService: jest.Mocked<DocumentReadService>;

  beforeEach(() => {
    documentReadService = {
      listOrganizationDocuments: jest.fn().mockResolvedValue(PAGE),
      findOrganizationDocument: jest.fn().mockResolvedValue(SUMMARY),
    } as unknown as jest.Mocked<DocumentReadService>;
  });

  describe('ListOrganizationIntegrationDocumentsUseCase', () => {
    it('lista sólo la organización de la llave, con los filtros del cliente', async () => {
      const query = { page: 2, statuses: [DOCUMENT_STATUS_ENUM.SIGNED] };

      const { data } = await new ListOrganizationIntegrationDocumentsUseCase(
        documentReadService,
      ).execute(apiClient(), query);

      expect(
        documentReadService.listOrganizationDocuments,
      ).toHaveBeenCalledWith({
        organizationId: 'org-1',
        filters: query,
      });
      expect(data).toBe(PAGE);
    });
  });

  describe('ListUserIntegrationDocumentsUseCase', () => {
    let accountRepository: { exists: jest.Mock };
    const useCase = () =>
      new ListUserIntegrationDocumentsUseCase(
        documentReadService,
        accountRepository as unknown as Repository<AccountEntity>,
      );

    beforeEach(() => {
      accountRepository = { exists: jest.fn().mockResolvedValue(true) };
    });

    it('con ORGANIZATION consulta a cualquier miembro activo, filtrando por organización y creador', async () => {
      await useCase().execute(apiClient(), 'user-otro', {});

      expect(accountRepository.exists).toHaveBeenCalledWith({
        where: { userId: 'user-otro', organizationId: 'org-1', isActive: true },
      });
      expect(
        documentReadService.listOrganizationDocuments,
      ).toHaveBeenCalledWith({
        organizationId: 'org-1',
        createdBy: 'user-otro',
        filters: {},
      });
    });

    it('con sólo OWN consulta al actor de la llave', async () => {
      await useCase().execute(
        apiClient([PERMISSION_SCOPE_ENUM.OWN]),
        'user-actor',
        {},
      );

      expect(
        documentReadService.listOrganizationDocuments,
      ).toHaveBeenCalledWith(
        expect.objectContaining({ createdBy: 'user-actor' }),
      );
    });

    it('con sólo OWN rechaza a otro usuario antes de mirar su membresía', async () => {
      await expect(
        useCase().execute(
          apiClient([PERMISSION_SCOPE_ENUM.OWN]),
          'user-otro',
          {},
        ),
      ).rejects.toBeInstanceOf(IntegrationScopeDeniedException);
      expect(accountRepository.exists).not.toHaveBeenCalled();
    });

    it('responde 404 a un usuario que no es miembro activo de la organización', async () => {
      accountRepository.exists.mockResolvedValue(false);

      await expect(
        useCase().execute(apiClient(), 'user-de-otra-org', {}),
      ).rejects.toBeInstanceOf(IntegrationUserNotFoundException);
      expect(
        documentReadService.listOrganizationDocuments,
      ).not.toHaveBeenCalled();
    });
  });
});
