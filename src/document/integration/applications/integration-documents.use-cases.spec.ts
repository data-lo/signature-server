import { QueryFailedError, Repository } from 'typeorm';

import { AccountEntity } from 'src/account/entities/account.entity';
import { IntegrationApiClient } from 'src/api-key/interfaces/integration-api-client.interface';
import { ACTION_KEY_ENUM } from 'src/roles/enums/action-key.enum';
import { PERMISSION_SCOPE_ENUM } from 'src/roles/enums/permission-scope.enum';
import { RESOURCE_KEY_ENUM } from 'src/roles/enums/resource-key.enum';

import { CreateDocumentSignatureFlowUseCase } from '../../applications/create-document-signature-flow.use-case';
import { DOCUMENT_STATUS_ENUM } from '../../enum/document-status.enum';
import { SIGNATURE_TYPE_ENUM } from '../../enum/signature-type.enum';
import { DocumentReadService } from '../../services/document-read.service';
import { CreateIntegrationDocumentDto } from '../dto/create-integration-document.dto';
import {
  IdempotencyKeyMismatchException,
  IntegrationScopeDeniedException,
  IntegrationUserNotFoundException,
} from '../exceptions/integration-document.exceptions';
import { IntegrationIdempotencyService } from '../services/integration-idempotency.service';
import { CreateIntegrationDocumentUseCase } from './create-integration-document.use-case';
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

  describe('CreateIntegrationDocumentUseCase', () => {
    let flow: { execute: jest.Mock };
    let idempotency: { find: jest.Mock; record: jest.Mock };
    const dto = {} as CreateIntegrationDocumentDto;
    const file = { buffer: Buffer.from('%PDF') } as Express.Multer.File;
    const useCase = () =>
      new CreateIntegrationDocumentUseCase(
        flow as unknown as CreateDocumentSignatureFlowUseCase,
        idempotency as unknown as IntegrationIdempotencyService,
        documentReadService,
      );
    const request = () => ({
      apiClient: apiClient(),
      dto,
      file,
      ip: '203.0.113.7',
      idempotencyKey: 'erp-pedido-1',
      requestFingerprint: 'huella-1',
    });

    beforeEach(() => {
      flow = {
        execute: jest.fn().mockResolvedValue({ data: { id: 'doc-1' } }),
      };
      idempotency = {
        find: jest.fn().mockResolvedValue(null),
        record: jest.fn().mockResolvedValue(undefined),
      };
    });

    it('delega en el flujo moderno con el actor y la cuenta de la llave, y su origen', async () => {
      const result = await useCase().execute(request());

      expect(flow.execute).toHaveBeenCalledWith(
        'user-actor',
        'account-actor',
        dto,
        file,
        '203.0.113.7',
        expect.objectContaining({
          apiKeyId: 'key-1',
          apiKeyName: 'Integración ERP',
          onDocumentSaved: expect.any(Function),
        }),
      );
      expect(result).toMatchObject({ replayed: false, data: SUMMARY });
    });

    it('registra la clave en la transacción del alta, con la huella y el documento', async () => {
      await useCase().execute(request());
      const { onDocumentSaved } = flow.execute.mock.calls[0][5];
      const manager = {};

      await onDocumentSaved(manager, { id: 'doc-1' });

      expect(idempotency.record).toHaveBeenCalledWith(manager, {
        organizationId: 'org-1',
        apiKeyId: 'key-1',
        idempotencyKey: 'erp-pedido-1',
        requestFingerprint: 'huella-1',
        documentId: 'doc-1',
      });
    });

    it('una clave ya usada con la misma huella devuelve el documento original sin volver a crear', async () => {
      idempotency.find.mockResolvedValue({
        requestFingerprint: 'huella-1',
        documentId: 'doc-1',
      });

      const result = await useCase().execute(request());

      expect(flow.execute).not.toHaveBeenCalled();
      expect(documentReadService.findOrganizationDocument).toHaveBeenCalledWith(
        'org-1',
        'doc-1',
      );
      expect(result).toMatchObject({ replayed: true, data: SUMMARY });
    });

    it('una clave ya usada con otra huella responde 409', async () => {
      idempotency.find.mockResolvedValue({
        requestFingerprint: 'otra-huella',
        documentId: 'doc-1',
      });

      await expect(useCase().execute(request())).rejects.toBeInstanceOf(
        IdempotencyKeyMismatchException,
      );
      expect(flow.execute).not.toHaveBeenCalled();
    });

    it('si otra petición registró la clave a la vez, responde con el documento de aquélla', async () => {
      const conflict = new QueryFailedError('insert', [], new Error('dup'));
      Object.assign(conflict, {
        driverError: {
          code: '23505',
          constraint: 'UQ_integration_idempotency_keys_organization_key',
        },
      });
      flow.execute.mockRejectedValue(conflict);
      idempotency.find.mockResolvedValueOnce(null).mockResolvedValueOnce({
        requestFingerprint: 'huella-1',
        documentId: 'doc-1',
      });

      const result = await useCase().execute(request());

      expect(result.replayed).toBe(true);
    });

    it('cualquier otro error del flujo se propaga tal cual', async () => {
      flow.execute.mockRejectedValue(new Error('sin créditos'));

      await expect(useCase().execute(request())).rejects.toThrow(
        'sin créditos',
      );
    });
  });
});
