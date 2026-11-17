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
  IntegrationAmbiguousUserException,
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
    let accountRepository: { exists: jest.Mock; find: jest.Mock };
    const useCase = () =>
      new ListUserIntegrationDocumentsUseCase(
        documentReadService,
        accountRepository as unknown as Repository<AccountEntity>,
      );

    beforeEach(() => {
      accountRepository = {
        exists: jest.fn().mockResolvedValue(true),
        find: jest
          .fn()
          .mockResolvedValue([{ id: 'acc-1', userId: 'user-otro' }]),
      };
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

    describe('executeByEmail', () => {
      it('resuelve el correo sólo entre miembros activos de la organización de la llave', async () => {
        await useCase().executeByEmail(apiClient(), ' Beto@Acme.mx ', {});

        const [{ where }] = accountRepository.find.mock.calls[0];
        expect(where).toMatchObject({
          organizationId: 'org-1',
          isActive: true,
        });
        expect(where.user.email.getSql('alias')).toBe(
          'LOWER(alias) = :normalizedEmail',
        );
        expect(where.user.email.objectLiteralParameters).toEqual({
          normalizedEmail: 'beto@acme.mx',
        });
        expect(
          documentReadService.listOrganizationDocuments,
        ).toHaveBeenCalledWith(
          expect.objectContaining({ createdBy: 'user-otro' }),
        );
      });

      it('404 si el correo no es de un miembro activo', async () => {
        accountRepository.find.mockResolvedValue([]);

        await expect(
          useCase().executeByEmail(apiClient(), 'nadie@acme.mx', {}),
        ).rejects.toBeInstanceOf(IntegrationUserNotFoundException);
      });

      it('409 si el correo es de más de un miembro, sin listar nada', async () => {
        accountRepository.find.mockResolvedValue([
          { id: 'acc-1', userId: 'user-1' },
          { id: 'acc-2', userId: 'user-2' },
        ]);

        await expect(
          useCase().executeByEmail(apiClient(), 'gemelo@acme.mx', {}),
        ).rejects.toBeInstanceOf(IntegrationAmbiguousUserException);
        expect(
          documentReadService.listOrganizationDocuments,
        ).not.toHaveBeenCalled();
      });

      it('con sólo OWN admite el correo de su propio actor', async () => {
        accountRepository.find.mockResolvedValue([
          { id: 'acc-actor', userId: 'user-actor' },
        ]);

        await useCase().executeByEmail(
          apiClient([PERMISSION_SCOPE_ENUM.OWN]),
          'actor@acme.mx',
          {},
        );

        expect(
          documentReadService.listOrganizationDocuments,
        ).toHaveBeenCalledWith(
          expect.objectContaining({ createdBy: 'user-actor' }),
        );
      });

      it.each([
        ['de otro miembro', [{ id: 'acc-1', userId: 'user-otro' }]],
        ['que no existe', []],
      ])(
        'con sólo OWN responde lo mismo, 403, a un correo %s',
        async (_label, memberships) => {
          accountRepository.find.mockResolvedValue(memberships);

          await expect(
            useCase().executeByEmail(
              apiClient([PERMISSION_SCOPE_ENUM.OWN]),
              'alguien@acme.mx',
              {},
            ),
          ).rejects.toBeInstanceOf(IntegrationScopeDeniedException);
        },
      );
    });
  });
});
