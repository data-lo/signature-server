import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { ArchiveCompletedDocumentUseCase } from './archive-document.use-case';
import { DocumentService } from '../document.service';
import { DOCUMENT_STATUS_ENUM } from '../enum/document-status.enum';
import { DocumentUserPreferenceEntity } from '../preferences/document-user-preference.entity';

const DOCUMENT_ID = 'doc-1';
const USER_ID = 'user-1';

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

describe('ArchiveCompletedDocumentUseCase', () => {
  let useCase: ArchiveCompletedDocumentUseCase;
  let preferenceRepository: ReturnType<typeof createPreferenceRepository>;
  let documentService: { assertUserHasAccess: jest.Mock };

  beforeEach(async () => {
    preferenceRepository = createPreferenceRepository();
    documentService = {
      assertUserHasAccess: jest.fn().mockResolvedValue({
        id: DOCUMENT_ID,
        status: DOCUMENT_STATUS_ENUM.SIGNED,
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ArchiveCompletedDocumentUseCase,
        {
          provide: getRepositoryToken(DocumentUserPreferenceEntity),
          useValue: preferenceRepository,
        },
        { provide: DocumentService, useValue: documentService },
      ],
    }).compile();

    useCase = module.get(ArchiveCompletedDocumentUseCase);
  });

  it('archiva un documento firmado creando la preferencia del usuario que llama', async () => {
    const response = await useCase.execute(DOCUMENT_ID, USER_ID);

    expect(documentService.assertUserHasAccess).toHaveBeenCalledWith(
      DOCUMENT_ID,
      USER_ID,
    );
    expect(preferenceRepository.rows.size).toBe(1);

    const stored = preferenceRepository.rows.get(`${DOCUMENT_ID}:${USER_ID}`);
    expect(stored).toMatchObject({ documentId: DOCUMENT_ID, userId: USER_ID });
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
   * La idempotencia que pide la historia: un doble clic en "Archivar" —o dos pestañas— no puede
   * fallar ni dejar dos preferencias del mismo par. La segunda llamada sólo mueve la fecha.
   */
  it('archivar dos veces no falla ni duplica la preferencia', async () => {
    const first = await useCase.execute(DOCUMENT_ID, USER_ID);
    const second = await useCase.execute(DOCUMENT_ID, USER_ID);

    expect(second.success).toBe(true);
    expect(preferenceRepository.upsert).toHaveBeenCalledTimes(2);
    expect(preferenceRepository.rows.size).toBe(1);
    expect(second.data?.archivedAt.getTime()).toBeGreaterThanOrEqual(
      first.data!.archivedAt.getTime(),
    );
  });

  /**
   * Archivar es sólo para lo que ya terminó: esconder un documento que todavía espera una firma
   * dejaría a su firmante sin la lista donde iba a encontrarlo.
   */
  it.each([
    DOCUMENT_STATUS_ENUM.CREATED,
    DOCUMENT_STATUS_ENUM.PENDING,
    DOCUMENT_STATUS_ENUM.REJECTED,
    DOCUMENT_STATUS_ENUM.CANCELLATION_PENDING,
    DOCUMENT_STATUS_ENUM.CANCELLED,
    DOCUMENT_STATUS_ENUM.EXPIRED,
  ])(
    'rechaza con BadRequestException un documento en estatus %s',
    async (status) => {
      documentService.assertUserHasAccess.mockResolvedValue({
        id: DOCUMENT_ID,
        status,
      });

      await expect(useCase.execute(DOCUMENT_ID, USER_ID)).rejects.toThrow(
        BadRequestException,
      );
      expect(preferenceRepository.upsert).not.toHaveBeenCalled();
    },
  );

  /**
   * El acceso lo decide `assertUserHasAccess` (creador, colaborador vinculado o invitado por
   * correo). Lo que esta prueba fija es que el caso de uso no escribe NADA cuando ese chequeo
   * falla: sin él, cualquiera con un UUID podría sembrar filas sobre un documento ajeno.
   */
  it('no archiva si el usuario no tiene acceso al documento', async () => {
    documentService.assertUserHasAccess.mockRejectedValue(
      new ForbiddenException('No tienes acceso a este documento'),
    );

    await expect(useCase.execute(DOCUMENT_ID, 'intruso')).rejects.toThrow(
      ForbiddenException,
    );
    expect(preferenceRepository.upsert).not.toHaveBeenCalled();
  });
});
