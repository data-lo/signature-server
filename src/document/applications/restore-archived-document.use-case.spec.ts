import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { AuthorizationContext } from 'src/authorization/interfaces/authorization-context.interface';
import { AuthorizationService } from 'src/authorization/services/authorization.service';
import { ACTION_KEY_ENUM } from 'src/roles/enums/action-key.enum';
import { PERMISSION_SCOPE_ENUM } from 'src/roles/enums/permission-scope.enum';
import { RESOURCE_KEY_ENUM } from 'src/roles/enums/resource-key.enum';

import { RestoreArchivedDocumentUseCase } from './restore-archived-document.use-case';
import { DocumentService } from '../document.service';
import { CollaboratorEntity } from '../entities/collaborator.entity';
import { DocumentEntity } from '../entities/document.entity';
import { COLABORATOR_TYPE_ENUM } from '../enum/colaborator-type.enum';
import { DOCUMENT_STATUS_ENUM } from '../enum/document-status.enum';
import { DocumentAuthorizationPolicy } from '../policies/document-authorization.policy';
import { DocumentUserPreferenceEntity } from '../preferences/document-user-preference.entity';
import { DocumentReadAccessService } from '../services/document-read-access.service';

const DOCUMENT_ID = 'doc-1';
const ORGANIZATION_ID = 'org-1';
const CREATOR_ID = 'creator-1';
const ADMIN_ID = 'admin-1';
const MEMBER_ID = 'member-1';
const SIGNER_ID = 'signer-1';

type PreferenceRow = {
  documentId: string;
  userId: string;
  archivedAt: Date | null;
};

/**
 * Repositorio de preferencias con la semántica real de `update`: modifica sólo la fila del par
 * (documento, usuario) indicado y, si no existe, no hace nada. Así las pruebas ven que recuperar
 * toca SÓLO la preferencia de quien llama.
 */
function createPreferenceRepository(initial: PreferenceRow[] = []) {
  const rows = new Map<string, PreferenceRow>(
    initial.map((row) => [`${row.documentId}:${row.userId}`, { ...row }]),
  );

  return {
    rows,
    update: jest.fn(
      async (
        criteria: { documentId: string; userId: string },
        values: Partial<PreferenceRow>,
      ) => {
        const key = `${criteria.documentId}:${criteria.userId}`;
        const row = rows.get(key);
        if (row) rows.set(key, { ...row, ...values });
        return { affected: row ? 1 : 0, raw: [], generatedMaps: [] };
      },
    ),
  };
}

function signer(userId: string): CollaboratorEntity {
  return Object.assign(new CollaboratorEntity(), {
    colaboratorType: COLABORATOR_TYPE_ENUM.SIGNER,
    accountId: `account-${userId}`,
    account: { userId },
  });
}

function buildDocument(
  overrides: Partial<DocumentEntity> = {},
): DocumentEntity {
  return Object.assign(new DocumentEntity(), {
    id: DOCUMENT_ID,
    status: DOCUMENT_STATUS_ENUM.SIGNED,
    createdBy: CREATOR_ID,
    organizationId: ORGANIZATION_ID,
    collaborators: [signer(SIGNER_ID)],
    ...overrides,
  });
}

function authorizationFor(
  userId: string,
  scopes: PERMISSION_SCOPE_ENUM[],
): AuthorizationContext {
  return {
    userId,
    organizationId: ORGANIZATION_ID,
    accountId: `account-${userId}`,
    roleId: 'role-1',
    resource: RESOURCE_KEY_ENUM.DOCUMENT,
    action: ACTION_KEY_ENUM.READ,
    scopes,
  };
}

const OWN_ONLY = [PERMISSION_SCOPE_ENUM.OWN];
const OWN_AND_ORGANIZATION = [
  PERMISSION_SCOPE_ENUM.OWN,
  PERMISSION_SCOPE_ENUM.ORGANIZATION,
];
const ARCHIVED_AT = new Date('2026-09-20T12:00:00.000Z');

/**
 * Como en `ArchiveCompletedDocumentUseCase`, la autorización se ejerce con las piezas reales
 * —`DocumentReadAccessService` y `DocumentAuthorizationPolicy`—: recuperar lo puede quien puede
 * archivar, ni más ni menos.
 */
describe('RestoreArchivedDocumentUseCase', () => {
  let useCase: RestoreArchivedDocumentUseCase;
  let preferenceRepository: ReturnType<typeof createPreferenceRepository>;
  let documentRepository: { findOne: jest.Mock };

  async function build(initial: PreferenceRow[]) {
    preferenceRepository = createPreferenceRepository(initial);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RestoreArchivedDocumentUseCase,
        DocumentReadAccessService,
        DocumentAuthorizationPolicy,
        {
          provide: getRepositoryToken(DocumentUserPreferenceEntity),
          useValue: preferenceRepository,
        },
        {
          provide: getRepositoryToken(DocumentEntity),
          useValue: documentRepository,
        },
        {
          provide: DocumentService,
          useValue: {
            resolveMyCollaborator: jest.fn(
              async (collaborators: CollaboratorEntity[], userId: string) =>
                collaborators.find((c) => c.account?.userId === userId),
            ),
          },
        },
        {
          provide: AuthorizationService,
          useValue: {
            authorize: jest
              .fn()
              .mockRejectedValue(new ForbiddenException('Sin membresía')),
          },
        },
      ],
    }).compile();

    useCase = module.get(RestoreArchivedDocumentUseCase);
  }

  beforeEach(() => {
    documentRepository = {
      findOne: jest.fn().mockResolvedValue(buildDocument()),
    };
  });

  it('devuelve a la bandeja un documento que el creador archivó', async () => {
    await build([
      { documentId: DOCUMENT_ID, userId: CREATOR_ID, archivedAt: ARCHIVED_AT },
    ]);

    const response = await useCase.execute({
      documentId: DOCUMENT_ID,
      authorization: authorizationFor(CREATOR_ID, OWN_ONLY),
    });

    expect(
      preferenceRepository.rows.get(`${DOCUMENT_ID}:${CREATOR_ID}`)?.archivedAt,
    ).toBeNull();
    expect(response).toEqual({
      success: true,
      message: 'Documento recuperado correctamente',
      data: { documentId: DOCUMENT_ID, archived: false },
    });
  });

  /** Archivar es personal: recuperar tampoco toca lo que otro participante decidió. */
  it('sólo recupera la preferencia de quien llama, no la de otros participantes', async () => {
    await build([
      { documentId: DOCUMENT_ID, userId: SIGNER_ID, archivedAt: ARCHIVED_AT },
      { documentId: DOCUMENT_ID, userId: CREATOR_ID, archivedAt: ARCHIVED_AT },
    ]);

    await useCase.execute({
      documentId: DOCUMENT_ID,
      authorization: authorizationFor(SIGNER_ID, OWN_ONLY),
    });

    expect(preferenceRepository.update).toHaveBeenCalledWith(
      { documentId: DOCUMENT_ID, userId: SIGNER_ID },
      { archivedAt: null },
    );
    expect(
      preferenceRepository.rows.get(`${DOCUMENT_ID}:${CREATOR_ID}`)?.archivedAt,
    ).toEqual(ARCHIVED_AT);
  });

  it('con DOCUMENT.READ_ORGANIZATION recupera un documento de su organización que no creó', async () => {
    await build([
      { documentId: DOCUMENT_ID, userId: ADMIN_ID, archivedAt: ARCHIVED_AT },
    ]);

    await useCase.execute({
      documentId: DOCUMENT_ID,
      authorization: authorizationFor(ADMIN_ID, OWN_AND_ORGANIZATION),
    });

    expect(
      preferenceRepository.rows.get(`${DOCUMENT_ID}:${ADMIN_ID}`)?.archivedAt,
    ).toBeNull();
  });

  it('sin un alcance que cubra el documento responde 403 y no escribe nada', async () => {
    await build([
      { documentId: DOCUMENT_ID, userId: MEMBER_ID, archivedAt: ARCHIVED_AT },
    ]);

    await expect(
      useCase.execute({
        documentId: DOCUMENT_ID,
        authorization: authorizationFor(MEMBER_ID, OWN_ONLY),
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(preferenceRepository.update).not.toHaveBeenCalled();
  });

  it('responde 404 si el documento no existe', async () => {
    await build([]);
    documentRepository.findOne.mockResolvedValue(null);

    await expect(
      useCase.execute({
        documentId: 'doc-inexistente',
        authorization: authorizationFor(CREATOR_ID, OWN_ONLY),
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(preferenceRepository.update).not.toHaveBeenCalled();
  });

  /** Un doble clic en "Recuperar", o recuperar algo que nunca se archivó, no es un error. */
  it('es idempotente: recuperar algo que no estaba archivado responde igual', async () => {
    await build([]);

    await expect(
      useCase.execute({
        documentId: DOCUMENT_ID,
        authorization: authorizationFor(CREATOR_ID, OWN_ONLY),
      }),
    ).resolves.toMatchObject({ data: { archived: false } });
    await expect(
      useCase.execute({
        documentId: DOCUMENT_ID,
        authorization: authorizationFor(CREATOR_ID, OWN_ONLY),
      }),
    ).resolves.toMatchObject({ data: { archived: false } });
    expect(preferenceRepository.rows.size).toBe(0);
  });

  /** Archivar exige SIGNED; recuperar no esconde nada, así que no mira el estatus. */
  it('no depende del estatus del documento', async () => {
    await build([
      { documentId: DOCUMENT_ID, userId: CREATOR_ID, archivedAt: ARCHIVED_AT },
    ]);
    documentRepository.findOne.mockResolvedValue(
      buildDocument({ status: DOCUMENT_STATUS_ENUM.CANCELLED }),
    );

    await expect(
      useCase.execute({
        documentId: DOCUMENT_ID,
        authorization: authorizationFor(CREATOR_ID, OWN_ONLY),
      }),
    ).resolves.toMatchObject({ data: { archived: false } });
  });
});
