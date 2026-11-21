import {
  CertificadoRevocadoException,
  OCSPNotAvailableException,
} from 'src/efirma/efirma.exceptions';

import { CollaboratorEntity } from '../../entities/collaborator.entity';
import { DOCUMENT_STATUS_ENUM } from '../../enum/document-status.enum';
import { SIGNATURE_TYPE_ENUM } from '../../enum/signature-type.enum';
import { DocumentSealingJobEntity } from '../entities/document-sealing-job.entity';
import { SEALING_JOB_STATUS_ENUM } from '../enums/sealing-job-status.enum';
import { SEALING_PHASE_ENUM } from '../enums/sealing-phase.enum';
import { SEALING_TYPE_ENUM } from '../enums/sealing-type.enum';
import {
  DocumentAlreadySealedException,
  DocumentSealingJobFailedException,
  SealedEvidencePdfUpdateException,
  SealingJobLeaseLostException,
  SealPersistenceException,
  SealReconciliationRequiredException,
} from '../exceptions/seal.exceptions';
import {
  SEALING_FAILURE_CODE_ENUM,
  SEALING_FAILURE_KIND_ENUM,
} from '../interfaces/sealing-failure.interface';
import { ProcessDocumentSealingJobUseCase } from './process-document-sealing-job.use-case';

const LEASE = '11111111-1111-4111-8111-111111111111';
const SNAPSHOT_REF = { objectKey: 'doc-1/snap.json', hash: 'h'.repeat(64) };

/** Trabajo reclamado por este worker. */
function claimedJob(
  overrides: Partial<DocumentSealingJobEntity> = {},
): DocumentSealingJobEntity {
  return {
    id: 'job-1',
    documentId: 'doc-1',
    sealType: SEALING_TYPE_ENUM.ADVANCED,
    status: SEALING_JOB_STATUS_ENUM.PROCESSING,
    phase: SEALING_PHASE_ENUM.VERIFYING_OCSP,
    attemptCount: 1,
    nextAttemptAt: new Date(),
    leaseToken: LEASE,
    leaseExpiresAt: new Date(Date.now() + 60_000),
    requestObjectKey: null,
    requestHash: null,
    lastErrorCode: null,
    lastErrorMessage: null,
    lastUpstreamStatus: null,
    completedAt: null,
    ...overrides,
  } as DocumentSealingJobEntity;
}

function fielSigner(id: string, status: 'good' | 'unknown' | null) {
  return {
    id,
    signatureType: SIGNATURE_TYPE_ENUM.FIEL,
    advancedSignature: {
      signatureBase64: `firma-${id}`,
      ...(status && { ocspEvidence: { status } }),
    },
  } as unknown as CollaboratorEntity;
}

/**
 * Tabla `document_sealing_jobs` en memoria: los `UPDATE` sólo aplican si la fila sigue en
 * `PROCESSING` con el mismo `lease_token`, igual que en Postgres.
 */
class FakeJobTable {
  constructor(public row: DocumentSealingJobEntity) {}

  findOneBy = jest.fn(async ({ id }: { id: string }) =>
    id === this.row.id ? { ...this.row } : null,
  );

  createQueryBuilder = () => {
    let changes: Record<string, unknown> = {};
    const params: Record<string, unknown> = {};
    const builder = {
      update: () => builder,
      set: (values: Record<string, unknown>) => {
        changes = values;
        return builder;
      },
      where: (_: string, p: Record<string, unknown>) => {
        Object.assign(params, p);
        return builder;
      },
      andWhere: (_: string, p: Record<string, unknown>) => {
        Object.assign(params, p);
        return builder;
      },
      execute: async () => {
        const owned =
          params.id === this.row.id &&
          params.status === this.row.status &&
          params.leaseToken === this.row.leaseToken;
        if (!owned) {
          return { affected: 0 };
        }
        for (const [key, value] of Object.entries(changes)) {
          (this.row as unknown as Record<string, unknown>)[key] =
            typeof value === 'function' ? new Date() : value;
        }
        return { affected: 1 };
      },
    };
    return builder;
  };
}

describe('ProcessDocumentSealingJobUseCase', () => {
  let table: FakeJobTable;
  let documentUpdates: unknown[];
  let documentRepository: { findOne: jest.Mock };
  let sealRepository: { findOneBy: jest.Mock };
  let retryPendingSeal: { execute: jest.Mock };
  let snapshots: {
    freezeAdvancedSignatureRequest: jest.Mock;
    load: jest.Mock;
    discard: jest.Mock;
  };
  let sealDocument: { create: jest.Mock; findByDocumentId: jest.Mock };
  let sealSimple: { execute: jest.Mock };
  let refresher: { refresh: jest.Mock };
  let sealApi: { getSealOperation: jest.Mock };
  let processor: ProcessDocumentSealingJobUseCase;

  const ADVANCED_REQUEST = {
    documentId: 'doc-1',
    originalHash: 'h',
    signatures: [],
  };
  const SEAL = { id: 'seal-1', documentId: 'doc-1' };

  function build(job: DocumentSealingJobEntity) {
    table = new FakeJobTable(job);
    documentUpdates = [];
    const jobRepository = {
      findOneBy: table.findOneBy,
      createQueryBuilder: table.createQueryBuilder,
      manager: {
        // Una transacción que se revierte si el callback lanza: los cambios se aplican sobre una copia.
        transaction: async (
          work: (manager: unknown) => Promise<void>,
        ): Promise<void> => {
          const snapshot = { ...table.row };
          const pendingDocumentUpdates: unknown[] = [];
          try {
            await work({
              createQueryBuilder: table.createQueryBuilder,
              update: async (_entity: unknown, where: unknown, set: unknown) =>
                pendingDocumentUpdates.push({ where, set }),
            });
            documentUpdates.push(...pendingDocumentUpdates);
          } catch (error) {
            table.row = snapshot;
            throw error;
          }
        },
      },
    };

    processor = new ProcessDocumentSealingJobUseCase(
      jobRepository as never,
      documentRepository as never,
      sealRepository as never,
      retryPendingSeal as never,
      snapshots as never,
      sealDocument as never,
      sealSimple as never,
      sealApi as never,
    );
    processor.useEvidenceRefresher(refresher);
  }

  beforeEach(() => {
    documentRepository = {
      findOne: jest.fn().mockResolvedValue({
        id: 'doc-1',
        status: DOCUMENT_STATUS_ENUM.SIGNED,
        signedHash: 'hash-firmado',
      }),
    };
    sealRepository = { findOneBy: jest.fn().mockResolvedValue(null) };
    retryPendingSeal = {
      execute: jest
        .fn()
        .mockResolvedValue([
          fielSigner('c-1', 'good'),
          fielSigner('c-2', 'good'),
        ]),
    };
    snapshots = {
      freezeAdvancedSignatureRequest: jest.fn().mockResolvedValue(SNAPSHOT_REF),
      load: jest.fn().mockResolvedValue({
        sealType: SEALING_TYPE_ENUM.ADVANCED,
        documentId: 'doc-1',
        request: ADVANCED_REQUEST,
      }),
      discard: jest.fn(),
    };
    sealDocument = {
      create: jest.fn().mockResolvedValue(SEAL),
      findByDocumentId: jest.fn(),
    };
    sealSimple = { execute: jest.fn().mockResolvedValue(SEAL) };
    refresher = { refresh: jest.fn().mockResolvedValue(undefined) };
    sealApi = {
      getSealOperation: jest.fn().mockResolvedValue({ status: 'NOT_FOUND' }),
    };
  });

  /** Lo que lanzó el intento, con su fallo tipado. */
  async function failureOf(promise: Promise<void>) {
    const error = await promise.then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(DocumentSealingJobFailedException);
    return (error as DocumentSealingJobFailedException).failure;
  }

  describe('firma avanzada de punta a punta', () => {
    it('completa OCSP, congela con los datos recargados, sella, actualiza el PDF y cierra', async () => {
      build(claimedJob());

      await processor.execute('job-1', LEASE);

      const order = [
        retryPendingSeal.execute.mock.invocationCallOrder[0],
        snapshots.freezeAdvancedSignatureRequest.mock.invocationCallOrder[0],
        sealDocument.create.mock.invocationCallOrder[0],
        refresher.refresh.mock.invocationCallOrder[0],
      ];
      expect(order).toEqual([...order].sort((a, b) => a - b));

      expect(snapshots.load).toHaveBeenCalledWith(SNAPSHOT_REF);
      expect(sealDocument.create).toHaveBeenCalledWith(ADVANCED_REQUEST);
      expect(refresher.refresh).toHaveBeenCalledWith('doc-1', SEAL);

      expect(table.row).toEqual(
        expect.objectContaining({
          status: SEALING_JOB_STATUS_ENUM.COMPLETED,
          phase: SEALING_PHASE_ENUM.UPDATING_EVIDENCE_PDF,
          requestObjectKey: SNAPSHOT_REF.objectKey,
          requestHash: SNAPSHOT_REF.hash,
          leaseToken: null,
          leaseExpiresAt: null,
          completedAt: expect.any(Date),
        }),
      );
      expect(documentUpdates).toEqual([
        { where: { id: 'doc-1' }, set: { sealingPendingAt: null } },
      ]);
    });
  });

  describe('OCSP', () => {
    it('SAT caído: reintentable, sigue en VERIFYING_OCSP y no limpia el pendiente', async () => {
      build(claimedJob());
      retryPendingSeal.execute.mockRejectedValue(
        new OCSPNotAvailableException(),
      );

      const failure = await failureOf(processor.execute('job-1', LEASE));

      expect(failure).toEqual(
        expect.objectContaining({
          kind: SEALING_FAILURE_KIND_ENUM.RETRYABLE,
          code: SEALING_FAILURE_CODE_ENUM.OCSP_UNAVAILABLE,
          phase: SEALING_PHASE_ENUM.VERIFYING_OCSP,
        }),
      );
      expect(table.row.phase).toBe(SEALING_PHASE_ENUM.VERIFYING_OCSP);
      expect(table.row.status).toBe(SEALING_JOB_STATUS_ENUM.PROCESSING);
      expect(documentUpdates).toEqual([]);
      expect(sealDocument.create).not.toHaveBeenCalled();
    });

    it('certificado revocado: terminal, sin sellar', async () => {
      build(claimedJob());
      retryPendingSeal.execute.mockRejectedValue(
        new CertificadoRevocadoException(new Date('2026-10-01T00:00:00.000Z')),
      );

      const failure = await failureOf(processor.execute('job-1', LEASE));

      expect(failure.kind).toBe(SEALING_FAILURE_KIND_ENUM.TERMINAL);
      expect(failure.code).toBe(
        SEALING_FAILURE_CODE_ENUM.OCSP_CERTIFICATE_REVOKED,
      );
      expect(failure.message).toContain('2026-10-01T00:00:00.000Z');
      expect(snapshots.freezeAdvancedSignatureRequest).not.toHaveBeenCalled();
      expect(sealDocument.create).not.toHaveBeenCalled();
    });

    it('respuesta unknown: reintento acotado, nunca se sella como good', async () => {
      build(claimedJob());
      retryPendingSeal.execute.mockResolvedValue([
        fielSigner('c-1', 'good'),
        fielSigner('c-2', 'unknown'),
      ]);

      const failure = await failureOf(processor.execute('job-1', LEASE));

      expect(failure).toEqual(
        expect.objectContaining({
          kind: SEALING_FAILURE_KIND_ENUM.RETRYABLE,
          code: SEALING_FAILURE_CODE_ENUM.OCSP_STATUS_UNKNOWN,
          maxAttempts: 3,
        }),
      );
      expect(failure.message).toContain('c-2');
      expect(snapshots.freezeAdvancedSignatureRequest).not.toHaveBeenCalled();
    });

    it('un firmante que sigue sin evidencia tras la consulta no se sella', async () => {
      build(claimedJob());
      retryPendingSeal.execute.mockResolvedValue([fielSigner('c-1', null)]);

      const failure = await failureOf(processor.execute('job-1', LEASE));

      expect(failure.code).toBe(
        SEALING_FAILURE_CODE_ENUM.ADVANCED_EVIDENCE_INCOMPLETE,
      );
    });
  });

  describe('sellado', () => {
    it('una constancia existente antes de empezar nunca se vuelve a emitir', async () => {
      build(claimedJob());
      sealRepository.findOneBy.mockResolvedValue(SEAL);

      await processor.execute('job-1', LEASE);

      expect(retryPendingSeal.execute).not.toHaveBeenCalled();
      expect(sealDocument.create).not.toHaveBeenCalled();
      expect(refresher.refresh).toHaveBeenCalledWith('doc-1', SEAL);
      expect(table.row.status).toBe(SEALING_JOB_STATUS_ENUM.COMPLETED);
    });

    /**
     * Fallo de persistencia tras la respuesta exitosa del proveedor: el trabajo se queda en
     * GENERATING_SEAL y el siguiente intento recibe de Seal Service la misma evidencia por la clave
     * idempotente, sin volver a pedir el OCSP.
     */
    it('si no se pudo guardar la constancia, el reintento retoma desde GENERATING_SEAL', async () => {
      build(claimedJob());
      sealDocument.create
        .mockRejectedValueOnce(new SealPersistenceException())
        .mockResolvedValueOnce(SEAL);

      const failure = await failureOf(processor.execute('job-1', LEASE));
      expect(failure).toEqual(
        expect.objectContaining({
          kind: SEALING_FAILURE_KIND_ENUM.RETRYABLE,
          code: SEALING_FAILURE_CODE_ENUM.SEAL_PERSISTENCE_FAILED,
          phase: SEALING_PHASE_ENUM.GENERATING_SEAL,
        }),
      );
      expect(table.row.phase).toBe(SEALING_PHASE_ENUM.GENERATING_SEAL);

      await processor.execute('job-1', LEASE);

      expect(retryPendingSeal.execute).toHaveBeenCalledTimes(1);
      expect(snapshots.freezeAdvancedSignatureRequest).toHaveBeenCalledTimes(1);
      expect(sealDocument.create).toHaveBeenCalledTimes(2);
      expect(sealDocument.create.mock.calls[1][0]).toBe(ADVANCED_REQUEST);
      expect(table.row.status).toBe(SEALING_JOB_STATUS_ENUM.COMPLETED);
    });

    describe('reintento con una solicitud que pudo quedar en curso', () => {
      const retriedJob = () =>
        claimedJob({
          attemptCount: 2,
          phase: SEALING_PHASE_ENUM.GENERATING_SEAL,
          requestObjectKey: SNAPSHOT_REF.objectKey,
          requestHash: SNAPSHOT_REF.hash,
        });

      it('primer intento: no consulta, envía directo', async () => {
        build(
          claimedJob({
            phase: SEALING_PHASE_ENUM.GENERATING_SEAL,
            requestObjectKey: SNAPSHOT_REF.objectKey,
            requestHash: SNAPSHOT_REF.hash,
          }),
        );

        await processor.execute('job-1', LEASE);

        expect(sealApi.getSealOperation).not.toHaveBeenCalled();
      });

      it('si Seal Service la sigue emitiendo, no reenvía: reintenta después', async () => {
        build(retriedJob());
        sealApi.getSealOperation.mockResolvedValue({ status: 'PROCESSING' });

        const failure = await failureOf(processor.execute('job-1', LEASE));

        expect(sealApi.getSealOperation).toHaveBeenCalledWith('doc-1');
        expect(failure.kind).toBe(SEALING_FAILURE_KIND_ENUM.RETRYABLE);
        expect(failure.code).toBe(SEALING_FAILURE_CODE_ENUM.SEAL_IN_PROGRESS);
        expect(sealDocument.create).not.toHaveBeenCalled();
      });

      it('si requiere conciliación, no reenvía', async () => {
        build(retriedJob());
        sealApi.getSealOperation.mockResolvedValue({
          status: 'RECONCILIATION_REQUIRED',
          error: { code: 'STALE_IN_FLIGHT_STEP' },
        });

        const failure = await failureOf(processor.execute('job-1', LEASE));

        expect(failure.kind).toBe(
          SEALING_FAILURE_KIND_ENUM.RECONCILIATION_REQUIRED,
        );
        expect(failure.message).toContain('STALE_IN_FLIGHT_STEP');
        expect(sealDocument.create).not.toHaveBeenCalled();
      });

      it.each(['COMPLETED', 'FAILED', 'NOT_FOUND'])(
        'operación %s: reenvía el mismo payload con la misma clave',
        async (status) => {
          build(retriedJob());
          sealApi.getSealOperation.mockResolvedValue({ status });

          await processor.execute('job-1', LEASE);

          expect(sealDocument.create).toHaveBeenCalledWith(ADVANCED_REQUEST);
        },
      );
    });

    it('si otro intento guardó primero (unicidad), usa esa constancia', async () => {
      build(
        claimedJob({
          phase: SEALING_PHASE_ENUM.GENERATING_SEAL,
          requestObjectKey: SNAPSHOT_REF.objectKey,
          requestHash: SNAPSHOT_REF.hash,
        }),
      );
      sealDocument.create.mockRejectedValue(
        new DocumentAlreadySealedException(),
      );
      sealDocument.findByDocumentId.mockResolvedValue(SEAL);

      await processor.execute('job-1', LEASE);

      expect(refresher.refresh).toHaveBeenCalledWith('doc-1', SEAL);
    });

    it('resultado incierto en Seal Service va a conciliación', async () => {
      build(
        claimedJob({
          phase: SEALING_PHASE_ENUM.GENERATING_SEAL,
          requestObjectKey: SNAPSHOT_REF.objectKey,
          requestHash: SNAPSHOT_REF.hash,
        }),
      );
      sealDocument.create.mockRejectedValue(
        new SealReconciliationRequiredException('PSC_UNCERTAIN_RESULT'),
      );

      const failure = await failureOf(processor.execute('job-1', LEASE));

      expect(failure.kind).toBe(
        SEALING_FAILURE_KIND_ENUM.RECONCILIATION_REQUIRED,
      );
      expect(failure.message).toContain('PSC_UNCERTAIN_RESULT');
    });

    it('firma simple: sella su payload congelado por el flujo SIMPLE', async () => {
      const simpleSnapshot = {
        sealType: SEALING_TYPE_ENUM.SIMPLE,
        documentId: 'doc-1',
        signatures: [],
      };
      snapshots.load.mockResolvedValue(simpleSnapshot);
      build(
        claimedJob({
          sealType: SEALING_TYPE_ENUM.SIMPLE,
          phase: SEALING_PHASE_ENUM.GENERATING_SEAL,
          requestObjectKey: SNAPSHOT_REF.objectKey,
          requestHash: SNAPSHOT_REF.hash,
        }),
      );

      await processor.execute('job-1', LEASE);

      expect(sealSimple.execute).toHaveBeenCalledWith(simpleSnapshot);
      expect(sealDocument.create).not.toHaveBeenCalled();
      expect(retryPendingSeal.execute).not.toHaveBeenCalled();
    });

    it('un payload congelado de otro contrato no se envía', async () => {
      snapshots.load.mockResolvedValue({
        sealType: SEALING_TYPE_ENUM.SIMPLE,
        documentId: 'doc-1',
      });
      build(
        claimedJob({
          phase: SEALING_PHASE_ENUM.GENERATING_SEAL,
          requestObjectKey: SNAPSHOT_REF.objectKey,
          requestHash: SNAPSHOT_REF.hash,
        }),
      );

      const failure = await failureOf(processor.execute('job-1', LEASE));

      expect(failure.code).toBe(
        SEALING_FAILURE_CODE_ENUM.SEALING_REQUEST_UNAVAILABLE,
      );
      expect(sealSimple.execute).not.toHaveBeenCalled();
      expect(sealDocument.create).not.toHaveBeenCalled();
    });
  });

  describe('PDF final', () => {
    it('un fallo del PDF sólo repite esa fase, sin otro sello', async () => {
      build(claimedJob());
      refresher.refresh
        .mockRejectedValueOnce(new SealedEvidencePdfUpdateException())
        .mockResolvedValueOnce(undefined);

      const failure = await failureOf(processor.execute('job-1', LEASE));
      expect(failure).toEqual(
        expect.objectContaining({
          kind: SEALING_FAILURE_KIND_ENUM.RETRYABLE,
          code: SEALING_FAILURE_CODE_ENUM.EVIDENCE_PDF_UPDATE_FAILED,
          phase: SEALING_PHASE_ENUM.UPDATING_EVIDENCE_PDF,
        }),
      );
      expect(table.row.status).toBe(SEALING_JOB_STATUS_ENUM.PROCESSING);
      expect(documentUpdates).toEqual([]);

      // La constancia ya está guardada cuando se reintenta.
      sealRepository.findOneBy.mockResolvedValue(SEAL);
      await processor.execute('job-1', LEASE);

      expect(sealDocument.create).toHaveBeenCalledTimes(1);
      expect(refresher.refresh).toHaveBeenCalledTimes(2);
      expect(table.row.status).toBe(SEALING_JOB_STATUS_ENUM.COMPLETED);
    });

    it('si se pierde el reclamo antes de cerrar, la transacción no toca el documento', async () => {
      build(claimedJob({ phase: SEALING_PHASE_ENUM.UPDATING_EVIDENCE_PDF }));
      sealRepository.findOneBy.mockResolvedValue(SEAL);
      refresher.refresh.mockImplementation(async () => {
        // Otro worker recupera el trabajo mientras se publicaba el PDF.
        table.row.leaseToken = '22222222-2222-4222-8222-222222222222';
      });

      await expect(processor.execute('job-1', LEASE)).rejects.toBeInstanceOf(
        SealingJobLeaseLostException,
      );
      expect(table.row.status).toBe(SEALING_JOB_STATUS_ENUM.PROCESSING);
      expect(documentUpdates).toEqual([]);
    });
  });

  describe('propiedad del trabajo', () => {
    it('si el heartbeat perdió el lease, no empieza la fase siguiente', async () => {
      build(claimedJob());
      const ownership = new AbortController();
      retryPendingSeal.execute.mockImplementation(async () => {
        ownership.abort();
        return [fielSigner('c-1', 'good')];
      });

      await expect(
        processor.execute('job-1', LEASE, ownership.signal),
      ).rejects.toBeInstanceOf(SealingJobLeaseLostException);
      // Congelar sí ocurrió dentro de la fase OCSP; sellar, no.
      expect(sealDocument.create).not.toHaveBeenCalled();
      expect(refresher.refresh).not.toHaveBeenCalled();
    });

    it.each([
      [
        'otro token',
        claimedJob({ leaseToken: '33333333-3333-4333-8333-333333333333' }),
      ],
      [
        'reclamo vencido',
        claimedJob({ leaseExpiresAt: new Date(Date.now() - 1000) }),
      ],
      [
        'ya completado',
        claimedJob({ status: SEALING_JOB_STATUS_ENUM.COMPLETED }),
      ],
    ])('no hace nada si no le pertenece (%s)', async (_, job) => {
      build(job);

      await expect(processor.execute('job-1', LEASE)).rejects.toBeInstanceOf(
        SealingJobLeaseLostException,
      );
      expect(documentRepository.findOne).not.toHaveBeenCalled();
      expect(retryPendingSeal.execute).not.toHaveBeenCalled();
    });

    it('un documento que ya no está SIGNED va a conciliación sin tocar al proveedor', async () => {
      build(claimedJob());
      documentRepository.findOne.mockResolvedValue({
        id: 'doc-1',
        status: DOCUMENT_STATUS_ENUM.CANCELLATION_PENDING,
      });

      const failure = await failureOf(processor.execute('job-1', LEASE));

      expect(failure.code).toBe(SEALING_FAILURE_CODE_ENUM.DOCUMENT_NOT_SIGNED);
      expect(retryPendingSeal.execute).not.toHaveBeenCalled();
    });
  });
});
