import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';

import { DocumentEntity } from './../src/document/entities/document.entity';
import {
  DEFAULT_SEALING_WORKER_SETTINGS,
  SealingWorkerConfig,
} from './../src/document/seal/config/sealing-worker.config';
import { DocumentSealingJobEntity } from './../src/document/seal/entities/document-sealing-job.entity';
import { SealEntity } from './../src/document/seal/entities/seal.entity';
import { SEALING_PHASE_ENUM } from './../src/document/seal/enums/sealing-phase.enum';
import { SEALING_TYPE_ENUM } from './../src/document/seal/enums/sealing-type.enum';
import {
  SealingJobLeaseLostException,
  SealProviderUnavailableException,
} from './../src/document/seal/exceptions/seal.exceptions';
import { decideSealingRetry } from './../src/document/seal/policies/sealing-retry.policy';
import { SealingJobLeaseService } from './../src/document/seal/services/sealing-job-lease.service';
import { ClaimDueSealingJobsUseCase } from './../src/document/seal/use-cases/claim-due-sealing-jobs.use-case';
import { ProcessDocumentSealingJobUseCase } from './../src/document/seal/use-cases/process-document-sealing-job.use-case';
import { RegisterDocumentSealingJobUseCase } from './../src/document/seal/use-cases/register-document-sealing-job.use-case';
import { classifySealingError } from './../src/document/seal/utils/classify-sealing-error.util';
import { SealingTestDatabase } from './fixtures/sealing/sealing-test-database';

/**
 * Garantías de concurrencia del sellado contra Postgres real, con CONEXIONES INDEPENDIENTES: cada
 * "instancia" tiene su propio pool (`SealingTestDatabase.connect`), como dos réplicas del servidor.
 * Los dobles no pueden demostrar bloqueos, `SKIP LOCKED` ni las condiciones de los UPDATE.
 */
describe('Sellado de documentos: concurrencia con Postgres real (e2e)', () => {
  const db = new SealingTestDatabase('signature_sealing_concurrency_e2e');
  const config = {
    settings: { ...DEFAULT_SEALING_WORKER_SETTINGS, maxAttempts: 8 },
  } as SealingWorkerConfig;
  const register = new RegisterDocumentSealingJobUseCase();
  let instanceA: DataSource;
  let instanceB: DataSource;

  beforeAll(async () => {
    await db.create();
    instanceA = await db.connect();
    instanceB = await db.connect();
  }, 180_000);

  afterAll(() => db.destroy());

  beforeEach(() => db.dataSource.query(`DELETE FROM document_sealing_jobs`));

  const claimOn = (dataSource: DataSource) =>
    new ClaimDueSealingJobsUseCase(dataSource, config);
  const leasesOn = (dataSource: DataSource) =>
    new SealingJobLeaseService(
      dataSource.getRepository(DocumentSealingJobEntity),
      config,
    );

  /** Documento firmado con su trabajo PENDING. */
  async function pendingJob(): Promise<{ documentId: string; jobId: string }> {
    const documentId = await db.insertDocument();
    const { job } = await db.dataSource.transaction((manager) =>
      register.execute(
        { documentId, sealType: SEALING_TYPE_ENUM.ADVANCED },
        manager,
      ),
    );
    return { documentId, jobId: job.id };
  }

  async function jobRow(jobId: string) {
    const [row] = await db.dataSource.query(
      `SELECT status, attempt_count, lease_token, lease_expires_at FROM document_sealing_jobs WHERE id = $1`,
      [jobId],
    );
    return row;
  }

  /** Resuelve con `'pending'` si la promesa sigue esperando tras `ms`. */
  const stateAfter = <T>(promise: Promise<T>, ms: number) =>
    Promise.race([
      promise.then(() => 'settled' as const),
      new Promise<'pending'>((resolve) =>
        setTimeout(() => resolve('pending'), ms),
      ),
    ]);

  describe('registro', () => {
    it('unicidad: el segundo registro espera al primero y no crea otro trabajo', async () => {
      const documentId = await db.insertDocument({
        status: 'PENDING_SIGNATURE',
      });
      const runnerA = instanceA.createQueryRunner();
      await runnerA.connect();
      await runnerA.startTransaction();
      const first = await register.execute(
        { documentId, sealType: SEALING_TYPE_ENUM.ADVANCED },
        runnerA.manager,
      );

      const second = instanceB.transaction((manager) =>
        register.execute(
          { documentId, sealType: SEALING_TYPE_ENUM.SIMPLE },
          manager,
        ),
      );
      // B queda bloqueado por la restricción única mientras A no confirme.
      expect(await stateAfter(second, 300)).toBe('pending');

      await runnerA.commitTransaction();
      await runnerA.release();

      const result = await second;
      expect(first.created).toBe(true);
      expect(result.created).toBe(false);
      expect(result.job.id).toBe(first.job.id);
      expect(result.job.sealType).toBe(SEALING_TYPE_ENUM.ADVANCED);
      const rows = await db.dataSource.query(
        `SELECT id FROM document_sealing_jobs WHERE document_id = $1`,
        [documentId],
      );
      expect(rows).toHaveLength(1);
    });

    it('rollback del cierre: otra conexión no ve ni el trabajo ni el documento cerrado', async () => {
      const documentId = await db.insertDocument({
        status: 'PENDING_SIGNATURE',
      });
      const runnerA = instanceA.createQueryRunner();
      await runnerA.connect();
      await runnerA.startTransaction();
      await runnerA.query(
        `UPDATE documents SET status = 'SIGNED' WHERE id = $1`,
        [documentId],
      );
      await register.execute(
        { documentId, sealType: SEALING_TYPE_ENUM.ADVANCED },
        runnerA.manager,
      );

      // Antes de confirmar, B no ve nada.
      expect(
        await instanceB.query(
          `SELECT id FROM document_sealing_jobs WHERE document_id = $1`,
          [documentId],
        ),
      ).toEqual([]);

      await runnerA.rollbackTransaction();
      await runnerA.release();

      expect(
        await instanceB.query(
          `SELECT id FROM document_sealing_jobs WHERE document_id = $1`,
          [documentId],
        ),
      ).toEqual([]);
      const [document] = await instanceB.query(
        `SELECT status FROM documents WHERE id = $1`,
        [documentId],
      );
      expect(document.status).toBe('PENDING_SIGNATURE');
    });
  });

  describe('reclamo', () => {
    it('FOR UPDATE SKIP LOCKED: B salta sin esperar la fila que A tiene bloqueada', async () => {
      const locked = await pendingJob();
      const free1 = await pendingJob();
      const free2 = await pendingJob();
      const runnerA = instanceA.createQueryRunner();
      await runnerA.connect();
      await runnerA.startTransaction();
      await runnerA.query(
        `SELECT id FROM document_sealing_jobs WHERE id = $1 FOR UPDATE`,
        [locked.jobId],
      );

      const claimB = claimOn(instanceB).execute(10);
      expect(await stateAfter(claimB, 2_000)).toBe('settled');
      const claimed = await claimB;
      expect(claimed.map((job) => job.id).sort()).toEqual(
        [free1.jobId, free2.jobId].sort(),
      );

      await runnerA.rollbackTransaction();
      await runnerA.release();

      const later = await claimOn(instanceB).execute(10);
      expect(later.map((job) => job.id)).toEqual([locked.jobId]);
    });

    it('dos instancias reclamando a la vez se reparten los trabajos sin repetir', async () => {
      const ids: string[] = [];
      for (let i = 0; i < 12; i++) {
        ids.push((await pendingJob()).jobId);
      }

      const rounds = await Promise.all(
        [instanceA, instanceB, instanceA, instanceB].map((dataSource) =>
          claimOn(dataSource).execute(4),
        ),
      );

      const claimed = rounds.flat().map((job) => job.id);
      expect(claimed).toHaveLength(12);
      expect(new Set(claimed).size).toBe(12);
      expect(claimed.sort()).toEqual(ids.sort());
      expect(new Set(rounds.flat().map((job) => job.leaseToken)).size).toBe(12);
    });
  });

  describe('lease', () => {
    it('vigente no se roba; vencido lo recupera otra instancia con token nuevo', async () => {
      const { jobId } = await pendingJob();
      const [ofA] = await claimOn(instanceA).execute(1);

      expect(await claimOn(instanceB).execute(1)).toEqual([]);

      await db.dataSource.query(
        `UPDATE document_sealing_jobs SET lease_expires_at = now() - interval '1 second' WHERE id = $1`,
        [jobId],
      );
      const [ofB] = await claimOn(instanceB).execute(1);

      expect(ofB).toEqual(
        expect.objectContaining({
          id: jobId,
          recovered: true,
          attemptCount: 2,
        }),
      );
      expect(ofB.leaseToken).not.toBe(ofA.leaseToken);
    });

    it('renovar desde el dueño lo extiende; desde el antiguo no', async () => {
      await pendingJob();
      const [job] = await claimOn(instanceA).execute(1);
      await db.dataSource.query(
        `UPDATE document_sealing_jobs SET lease_expires_at = now() + interval '2 seconds' WHERE id = $1`,
        [job.id],
      );

      expect(await leasesOn(instanceB).renew(job.id, randomUUID())).toBe(false);
      expect(await leasesOn(instanceB).renew(job.id, job.leaseToken)).toBe(
        true,
      );
      const { lease_expires_at } = await jobRow(job.id);
      expect(new Date(lease_expires_at).getTime()).toBeGreaterThan(
        Date.now() + 100_000,
      );
    });
  });

  describe('escrituras condicionadas al propietario', () => {
    it('el worker antiguo no puede registrar un fallo ni procesar el trabajo del nuevo dueño', async () => {
      const { jobId } = await pendingJob();
      const [old] = await claimOn(instanceA).execute(1);
      await db.dataSource.query(
        `UPDATE document_sealing_jobs SET lease_expires_at = now() - interval '1 second' WHERE id = $1`,
        [jobId],
      );
      const [current] = await claimOn(instanceB).execute(1);

      const failure = classifySealingError(
        new SealProviderUnavailableException(),
        SEALING_PHASE_ENUM.GENERATING_SEAL,
      );
      expect(
        await leasesOn(instanceA).recordFailure(
          old.id,
          old.leaseToken,
          decideSealingRetry({ attemptCount: 1, failure, maxAttempts: 8 }),
          failure,
        ),
      ).toBe(false);
      await expect(
        processorOn(instanceA).execute(old.id, old.leaseToken),
      ).rejects.toBeInstanceOf(SealingJobLeaseLostException);

      expect(await jobRow(jobId)).toEqual(
        expect.objectContaining({
          status: 'PROCESSING',
          lease_token: current.leaseToken,
          attempt_count: 2,
        }),
      );
    });

    it('si otra instancia recupera el trabajo mientras se publica el PDF, el cierre se revierte entero', async () => {
      const { documentId, jobId } = await pendingJob();
      await db.dataSource.query(
        `UPDATE document_sealing_jobs SET phase = 'UPDATING_EVIDENCE_PDF' WHERE id = $1`,
        [jobId],
      );
      await db.dataSource.query(
        `INSERT INTO document_seals (document_id, signature_hash, canonical_payload, timestamp_evidence, integrity_evidence, sealed_at)
         VALUES ($1, 'h', 'c', '{}', '{}', now())`,
        [documentId],
      );
      const [old] = await claimOn(instanceA).execute(1);
      let current: { leaseToken: string } | undefined;

      const processor = processorOn(instanceA);
      processor.useEvidenceRefresher({
        refresh: async () => {
          // A publica el PDF lento; su lease vence y B lo recupera.
          await db.dataSource.query(
            `UPDATE document_sealing_jobs SET lease_expires_at = now() - interval '1 second' WHERE id = $1`,
            [jobId],
          );
          [current] = await claimOn(instanceB).execute(1);
        },
      });

      await expect(
        processor.execute(old.id, old.leaseToken),
      ).rejects.toBeInstanceOf(SealingJobLeaseLostException);

      expect(await jobRow(jobId)).toEqual(
        expect.objectContaining({
          status: 'PROCESSING',
          lease_token: current!.leaseToken,
        }),
      );
      // La marca del documento no se limpió: la transacción de cierre se revirtió.
      const [document] = await db.dataSource.query(
        `SELECT sealing_pending_at FROM documents WHERE id = $1`,
        [documentId],
      );
      expect(document.sealing_pending_at).toEqual(expect.any(Date));
    });
  });

  /** Procesador sobre una instancia; sólo se ejercitan la propiedad y el cierre. */
  function processorOn(dataSource: DataSource) {
    return new ProcessDocumentSealingJobUseCase(
      dataSource.getRepository(DocumentSealingJobEntity),
      dataSource.getRepository(DocumentEntity),
      dataSource.getRepository(SealEntity),
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
  }
});
