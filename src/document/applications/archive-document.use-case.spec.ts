import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { AuthorizationContext } from 'src/authorization/interfaces/authorization-context.interface';
import { AuthorizationService } from 'src/authorization/services/authorization.service';
import { ACTION_KEY_ENUM } from 'src/roles/enums/action-key.enum';
import { PERMISSION_SCOPE_ENUM } from 'src/roles/enums/permission-scope.enum';
import { RESOURCE_KEY_ENUM } from 'src/roles/enums/resource-key.enum';

import { ArchiveCompletedDocumentUseCase } from './archive-document.use-case';
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

/**
 * Repositorio de preferencias con la semántica real del `upsert` de Postgres: la fila se
 * identifica por el par (documento, usuario) y una segunda escritura del mismo par ACTUALIZA en
 * vez de insertar. Sin esto, un `jest.fn()` pelado no distinguiría "archivé dos veces y hay una
 * fila" de "archivé dos veces y hay dos", que es justo lo que estas pruebas tienen que ver.
 */
function createPreferenceRepository() {
  const rows = new Map<
    string,
    { documentId: string; userId: string; archivedAt: Date }
  >();

  return {
    rows,
    upsert: jest.fn(
      async (
        values: { documentId: string; userId: string; archivedAt: Date },
        options: { conflictPaths: string[] },
      ) => {
        expect(options.conflictPaths).toEqual(['documentId', 'userId']);
        rows.set(`${values.documentId}:${values.userId}`, { ...values });
        return { identifiers: [], generatedMaps: [], raw: [] };
      },
    ),
  };
}

/** Firmante vinculado a su cuenta, como lo carga el caso de uso (`collaborators.account`). */
function signer(userId: string): CollaboratorEntity {
  return Object.assign(new CollaboratorEntity(), {
    colaboratorType: COLABORATOR_TYPE_ENUM.SIGNER,
    accountId: `account-${userId}`,
    account: { userId },
  });
}

/** Documento de la organización, creado por `CREATOR_ID` y firmado por `SIGNER_ID`. */
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

/** Contexto que `PermissionsGuard` deja para `DOCUMENT + READ` en la organización activa. */
function authorizationFor(
  userId: string,
  scopes: PERMISSION_SCOPE_ENUM[],
  organizationId: string | null = ORGANIZATION_ID,
): AuthorizationContext {
  return {
    userId,
    organizationId,
    accountId: `account-${userId}`,
    roleId: 'role-1',
    resource: RESOURCE_KEY_ENUM.DOCUMENT,
    action: ACTION_KEY_ENUM.READ,
    scopes,
  };
}

/** Un MEMBER de fábrica: sólo `DOCUMENT.READ_OWN`. */
const OWN_ONLY = [PERMISSION_SCOPE_ENUM.OWN];
/** Un OWNER o ADMIN de fábrica: `DOCUMENT.READ_OWN` y `DOCUMENT.READ_ORGANIZATION`. */
const OWN_AND_ORGANIZATION = [
  PERMISSION_SCOPE_ENUM.OWN,
  PERMISSION_SCOPE_ENUM.ORGANIZATION,
];

/**
 * La autorización se ejerce con las piezas reales —`DocumentReadAccessService` y
 * `DocumentAuthorizationPolicy`—; sólo se doblan la base y la resolución de contexto en otra
 * organización. Así estas pruebas fijan QUIÉN puede archivar, no sólo que se llamó a algo.
 */
describe('ArchiveCompletedDocumentUseCase', () => {
  let useCase: ArchiveCompletedDocumentUseCase;
  let preferenceRepository: ReturnType<typeof createPreferenceRepository>;
  let documentRepository: { findOne: jest.Mock };
  let documentService: { resolveMyCollaborator: jest.Mock };
  let authorizationService: { authorize: jest.Mock };

  beforeEach(async () => {
    preferenceRepository = createPreferenceRepository();
    documentRepository = {
      findOne: jest.fn().mockResolvedValue(buildDocument()),
    };
    documentService = {
      resolveMyCollaborator: jest.fn(
        async (collaborators: CollaboratorEntity[], userId: string) =>
          collaborators.find((c) => c.account?.userId === userId),
      ),
    };
    authorizationService = {
      authorize: jest
        .fn()
        .mockRejectedValue(new ForbiddenException('Sin membresía')),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ArchiveCompletedDocumentUseCase,
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
        { provide: DocumentService, useValue: documentService },
        { provide: AuthorizationService, useValue: authorizationService },
      ],
    }).compile();

    useCase = module.get(ArchiveCompletedDocumentUseCase);
  });

  describe('quién puede archivar', () => {
    it('el creador con DOCUMENT.READ_OWN archiva su documento', async () => {
      const response = await useCase.execute({
        documentId: DOCUMENT_ID,
        authorization: authorizationFor(CREATOR_ID, OWN_ONLY),
      });

      expect(documentRepository.findOne).toHaveBeenCalledWith({
        where: { id: DOCUMENT_ID },
        relations: { collaborators: { account: true } },
      });

      const stored = preferenceRepository.rows.get(
        `${DOCUMENT_ID}:${CREATOR_ID}`,
      );
      expect(stored?.archivedAt).toBeInstanceOf(Date);
      expect(response).toMatchObject({
        success: true,
        data: {
          documentId: DOCUMENT_ID,
          archived: true,
          archivedAt: stored?.archivedAt,
        },
      });
    });

    /**
     * El caso de la historia: un ADMIN ve en su listado los documentos de toda la organización y
     * tiene que poder archivar los que no creó ni firma. La preferencia queda a SU nombre, no al
     * del creador.
     */
    it('quien no creó ni participa, con DOCUMENT.READ_ORGANIZATION, archiva un documento de su organización', async () => {
      await useCase.execute({
        documentId: DOCUMENT_ID,
        authorization: authorizationFor(ADMIN_ID, OWN_AND_ORGANIZATION),
      });

      expect(preferenceRepository.rows.size).toBe(1);
      expect(
        preferenceRepository.rows.get(`${DOCUMENT_ID}:${ADMIN_ID}`),
      ).toMatchObject({ documentId: DOCUMENT_ID, userId: ADMIN_ID });
      expect(authorizationService.authorize).not.toHaveBeenCalled();
    });

    it('un firmante que no lo creó, con DOCUMENT.READ_OWN, archiva el documento donde participa', async () => {
      await useCase.execute({
        documentId: DOCUMENT_ID,
        authorization: authorizationFor(SIGNER_ID, OWN_ONLY),
      });

      expect(preferenceRepository.rows.has(`${DOCUMENT_ID}:${SIGNER_ID}`)).toBe(
        true,
      );
    });

    /**
     * Invitado sólo por correo: su participación la resuelve `resolveMyCollaborator` yendo a la
     * base, y la Policy la recibe ya resuelta.
     */
    it('un invitado por correo sin cuenta vinculada, con DOCUMENT.READ_OWN, archiva', async () => {
      const invited = Object.assign(new CollaboratorEntity(), {
        colaboratorType: COLABORATOR_TYPE_ENUM.SIGNER,
        accountId: null,
        email: 'invitado@correo.com',
      });
      documentRepository.findOne.mockResolvedValue(
        buildDocument({ collaborators: [invited] }),
      );
      documentService.resolveMyCollaborator.mockResolvedValue(invited);

      await useCase.execute({
        documentId: DOCUMENT_ID,
        authorization: authorizationFor(MEMBER_ID, OWN_ONLY),
      });

      expect(preferenceRepository.rows.has(`${DOCUMENT_ID}:${MEMBER_ID}`)).toBe(
        true,
      );
    });

    /**
     * Mismo documento que archiva el ADMIN, pero para un MEMBER de fábrica: sin
     * `READ_ORGANIZATION` y sin participar, el documento ni siquiera está en su listado.
     */
    it('sin un alcance que cubra el documento responde 403 y no escribe nada', async () => {
      await expect(
        useCase.execute({
          documentId: DOCUMENT_ID,
          authorization: authorizationFor(MEMBER_ID, OWN_ONLY),
        }),
      ).rejects.toThrow(ForbiddenException);
      expect(preferenceRepository.upsert).not.toHaveBeenCalled();
    });

    /**
     * `READ_ORGANIZATION` alcanza a la organización del documento, no a cualquiera: si el
     * documento es de otra y ahí el usuario no tiene membresía con lectura, sigue siendo 403.
     */
    it('READ_ORGANIZATION de otra organización no alcanza', async () => {
      documentRepository.findOne.mockResolvedValue(
        buildDocument({ organizationId: 'org-2' }),
      );

      await expect(
        useCase.execute({
          documentId: DOCUMENT_ID,
          authorization: authorizationFor(ADMIN_ID, OWN_AND_ORGANIZATION),
        }),
      ).rejects.toThrow(ForbiddenException);
      expect(authorizationService.authorize).toHaveBeenCalledWith({
        userId: ADMIN_ID,
        organizationId: 'org-2',
        resource: RESOURCE_KEY_ENUM.DOCUMENT,
        action: ACTION_KEY_ENUM.READ,
      });
      expect(preferenceRepository.upsert).not.toHaveBeenCalled();
    });

    /** Un documento personal ajeno no entra por `READ_ORGANIZATION` aunque el rol lo tenga. */
    it('un documento personal ajeno no se archiva aunque se tenga READ_ORGANIZATION', async () => {
      documentRepository.findOne.mockResolvedValue(
        buildDocument({ organizationId: null }),
      );

      await expect(
        useCase.execute({
          documentId: DOCUMENT_ID,
          authorization: authorizationFor(ADMIN_ID, OWN_AND_ORGANIZATION),
        }),
      ).rejects.toThrow(ForbiddenException);
      expect(preferenceRepository.upsert).not.toHaveBeenCalled();
    });
  });

  it('responde 404 si el documento no existe', async () => {
    documentRepository.findOne.mockResolvedValue(null);

    await expect(
      useCase.execute({
        documentId: DOCUMENT_ID,
        authorization: authorizationFor(ADMIN_ID, OWN_AND_ORGANIZATION),
      }),
    ).rejects.toThrow(NotFoundException);
    expect(preferenceRepository.upsert).not.toHaveBeenCalled();
  });

  /**
   * La idempotencia que pide la historia: un doble clic en "Archivar" —o dos pestañas— no puede
   * fallar ni dejar dos preferencias del mismo par. La segunda llamada sólo mueve la fecha.
   */
  it('archivar dos veces no falla ni duplica la preferencia', async () => {
    const authorization = authorizationFor(ADMIN_ID, OWN_AND_ORGANIZATION);

    const first = await useCase.execute({
      documentId: DOCUMENT_ID,
      authorization,
    });
    const second = await useCase.execute({
      documentId: DOCUMENT_ID,
      authorization,
    });

    expect(second.success).toBe(true);
    expect(preferenceRepository.upsert).toHaveBeenCalledTimes(2);
    expect(preferenceRepository.rows.size).toBe(1);
    expect(second.data?.archivedAt.getTime()).toBeGreaterThanOrEqual(
      first.data!.archivedAt.getTime(),
    );
  });

  /**
   * Archivar es sólo para lo que ya terminó: esconder un documento que todavía espera una firma
   * dejaría a su firmante sin la lista donde iba a encontrarlo. La regla vale igual para quien
   * archiva por permiso de organización.
   */
  it.each([
    DOCUMENT_STATUS_ENUM.CREATED,
    DOCUMENT_STATUS_ENUM.PENDING_SIGNATURE,
    DOCUMENT_STATUS_ENUM.REJECTED,
    DOCUMENT_STATUS_ENUM.CANCELLATION_PENDING,
    DOCUMENT_STATUS_ENUM.CANCELLED,
    DOCUMENT_STATUS_ENUM.EXPIRED,
  ])(
    'rechaza con BadRequestException un documento en estatus %s',
    async (status) => {
      documentRepository.findOne.mockResolvedValue(buildDocument({ status }));

      await expect(
        useCase.execute({
          documentId: DOCUMENT_ID,
          authorization: authorizationFor(ADMIN_ID, OWN_AND_ORGANIZATION),
        }),
      ).rejects.toThrow(BadRequestException);
      expect(preferenceRepository.upsert).not.toHaveBeenCalled();
    },
  );

  /** A quien no puede ver el documento no se le cuenta en qué estado está. */
  it('autoriza antes de validar el estatus', async () => {
    documentRepository.findOne.mockResolvedValue(
      buildDocument({ status: DOCUMENT_STATUS_ENUM.PENDING_SIGNATURE }),
    );

    await expect(
      useCase.execute({
        documentId: DOCUMENT_ID,
        authorization: authorizationFor(MEMBER_ID, OWN_ONLY),
      }),
    ).rejects.toThrow(ForbiddenException);
  });
});
