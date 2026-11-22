import { randomUUID } from 'crypto';
import { config } from 'dotenv';
import { join } from 'path';
import { Client } from 'pg';
import { DataSource, EntityManager } from 'typeorm';

import { CollaboratorEntity } from './../src/document/entities/collaborator.entity';
import { DocumentSealingJobEntity } from './../src/document/seal/entities/document-sealing-job.entity';
import { SEALING_JOB_STATUS_ENUM } from './../src/document/seal/enums/sealing-job-status.enum';
import { SEALING_PHASE_ENUM } from './../src/document/seal/enums/sealing-phase.enum';
import { SEALING_TYPE_ENUM } from './../src/document/seal/enums/sealing-type.enum';
import { RegisterDocumentSealingJobUseCase } from './../src/document/seal/use-cases/register-document-sealing-job.use-case';
import { DocumentEntity } from './../src/document/entities/document.entity';
import { VerificationCodeEntity } from './../src/document/entities/verification-code.entity';
import { SealEntity } from './../src/document/seal/entities/seal.entity';
import {
  DocumentSealingJobFailedException,
  SealedEvidencePdfUpdateException,
  SealingJobLeaseLostException,
} from './../src/document/seal/exceptions/seal.exceptions';
import { SealingRequestSnapshotService } from './../src/document/seal/services/sealing-request-snapshot.service';
import { ProcessDocumentSealingJobUseCase } from './../src/document/seal/use-cases/process-document-sealing-job.use-case';
import { RetryPendingSealUseCase } from './../src/document/seal/use-cases/retry-pending-seal.use-case';
import { SealDocumentUseCase } from './../src/document/seal/use-cases/seal-document.use-case';
import {
  DEFAULT_SEALING_WORKER_SETTINGS,
  SealingWorkerConfig,
} from './../src/document/seal/config/sealing-worker.config';
import { decideSealingRetry } from './../src/document/seal/policies/sealing-retry.policy';
import { SealingJobLeaseService } from './../src/document/seal/services/sealing-job-lease.service';
import { ClaimDueSealingJobsUseCase } from './../src/document/seal/use-cases/claim-due-sealing-jobs.use-case';
import { classifySealingError } from './../src/document/seal/utils/classify-sealing-error.util';
import {
  IncompleteSimpleSignatureDataException,
  SealProviderResponseException,
  SealProviderUnavailableException,
} from './../src/document/seal/exceptions/seal.exceptions';
import { backfillPendingSealingJobs } from './../src/scripts/backfill-pending-sealing-jobs';

config();

/** Firma avanzada persistida del último firmante, sin llave privada ni contraseña. */
const ADVANCED_SIGNATURE = {
  originalHash: 'hash',
  signatureBase64: 'firma-en-base64',
  algorithm: 'sha256',
  signedAt: '2026-11-19T18:00:00.000Z',
  certificate: {
    rfc: 'PEAJ800101XXX',
    name: 'JUAN PEREZ',
    issuer: 'SERVICIO DE ADMINISTRACION TRIBUTARIA',
    serialNumber: '00001000000512345678',
    certificateNumber: '30001000000500003416',
    certificatePem:
      '-----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----',
  },
};

/**
 * Trabajos de sellado contra Postgres real (base desechable con TODAS las migraciones).
 *
 * Lo que sólo se prueba aquí y no con dobles: que la entidad y la migración coinciden, que un
 * rollback no deja el trabajo ni la evidencia, que dos cierres concurrentes del mismo documento
 * dejan un solo trabajo (lo resuelve la restricción única) y los `CHECK` de la tabla.
 */
describe('Trabajos de sellado de documentos (e2e)', () => {
  const DATABASE_NAME = `signature_sealing_jobs_e2e_${process.pid}_${Date.now()}`;
  const baseUrl = process.env.POSTGRES_DB_URL as string;
  const adminUrl = baseUrl.replace(/\/[^/?]+(\?.*)?$/, '/postgres$1');
  const databaseUrl = baseUrl.replace(
    /\/[^/?]+(\?.*)?$/,
    `/${DATABASE_NAME}$1`,
  );

  let dataSource: DataSource;
  const registerSealingJob = new RegisterDocumentSealingJobUseCase();
  const ids: Record<string, string> = {};

  async function adminQuery(sql: string): Promise<void> {
    const client = new Client({ connectionString: adminUrl });
    await client.connect();
    try {
      await client.query(sql);
    } finally {
      await client.end();
    }
  }

  async function insertReturningId(
    sql: string,
    params: unknown[],
  ): Promise<string> {
    const [row] = await dataSource.query(`${sql} RETURNING id`, params);
    return row.id as string;
  }

  /** Documento en `PENDING_SIGNATURE` con un firmante FIEL que ya firmó. */
  async function createDocumentWithFielSigner(): Promise<{
    documentId: string;
    collaboratorId: string;
  }> {
    const documentId = await insertReturningId(
      `INSERT INTO documents (object_key, file_name, file_type, total_pages, ip_address, original_hash, created_by, account_id, total_signers, status, signature_type)
       VALUES ($1, 'contrato.pdf', 'application/pdf', 1, '127.0.0.1', 'hash', $2, $3, 1, 'PENDING_SIGNATURE', 'FIEL')`,
      [`${randomUUID()}.pdf`, ids.user, ids.account],
    );
    const collaboratorId = await insertReturningId(
      `INSERT INTO collaborators (document_id, ip_address, colaborator_type, signature_type, status) VALUES ($1, '127.0.0.1', 'SIGNER', 'FIEL', 'SIGNED')`,
      [documentId],
    );
    return { documentId, collaboratorId };
  }

  async function jobsOf(documentId: string) {
    return dataSource.query(
      `SELECT status, phase, seal_type, attempt_count, request_object_key FROM document_sealing_jobs WHERE document_id = $1`,
      [documentId],
    );
  }

  /**
   * Lo que hace la transacción de cierre: la evidencia del último firmante, el documento en
   * SIGNED y el trabajo, con el mismo `EntityManager`.
   */
  async function closeDocument(
    manager: EntityManager,
    documentId: string,
    collaboratorId: string,
  ) {
    await manager.getRepository(CollaboratorEntity).update(collaboratorId, {
      advancedSignature: ADVANCED_SIGNATURE as never,
    });
    await manager.query(
      `UPDATE documents SET status = 'SIGNED', sealing_pending_at = now() WHERE id = $1`,
      [documentId],
    );
    return registerSealingJob.execute(
      { documentId, sealType: SEALING_TYPE_ENUM.ADVANCED },
      manager,
    );
  }

  beforeAll(async () => {
    await adminQuery(`CREATE DATABASE "${DATABASE_NAME}"`);

    dataSource = new DataSource({
      type: 'postgres',
      url: databaseUrl,
      entities: [join(__dirname, '..', 'src', '**', '*.entity{.ts,.js}')],
      migrations: [join(__dirname, '..', 'src', 'migrations', '*{.ts,.js}')],
      migrationsTransactionMode: 'each',
    });
    await dataSource.initialize();
    await dataSource.runMigrations();

    ids.user = await insertReturningId(
      // PROVISIONED: el CHECK de credenciales sólo aplica a usuarios activos.
      `INSERT INTO users (first_name, last_name, email, roles, lifecycle_status) VALUES ('Ana', 'López', $1, 'user', 'PROVISIONED')`,
      [`ana-${randomUUID()}@correo.example`],
    );
    ids.account = await insertReturningId(
      `INSERT INTO accounts (user_id, account_type, email) VALUES ($1, 'PERSONAL', 'ana@correo.example')`,
      [ids.user],
    );
  }, 180_000);

  afterAll(async () => {
    await dataSource?.destroy();
    await adminQuery(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${DATABASE_NAME}' AND pid <> pg_backend_pid()`,
    );
    await adminQuery(`DROP DATABASE IF EXISTS "${DATABASE_NAME}"`);
  });

  describe('esquema', () => {
    it('la entidad y la migración coinciden: el esquema no propone cambios para la tabla', async () => {
      const { upQueries } = await dataSource.driver.createSchemaBuilder().log();

      expect(
        upQueries
          .map(({ query }) => query)
          .filter((query) => query.includes('document_sealing_jobs')),
      ).toEqual([]);
    });

    it('crea los índices parciales con los nombres de la entidad', async () => {
      const indexes = await dataSource.query(
        `SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'document_sealing_jobs' ORDER BY indexname`,
      );
      const byName = Object.fromEntries(
        indexes.map((row: { indexname: string; indexdef: string }) => [
          row.indexname,
          row.indexdef,
        ]),
      );

      expect(byName.IDX_document_sealing_jobs_claimable).toContain(
        `WHERE ((status)::text = ANY ((ARRAY['PENDING'::character varying, 'RETRY_SCHEDULED'::character varying])::text[]))`,
      );
      expect(byName.IDX_document_sealing_jobs_expired_lease).toContain(
        `WHERE ((status)::text = 'PROCESSING'::text)`,
      );
      expect(byName.UQ_document_sealing_jobs_document_id).toContain('UNIQUE');
    });

    it('rechaza attempt_count negativo y estados, fases o tipos desconocidos', async () => {
      const { documentId } = await createDocumentWithFielSigner();
      const insert = (column: string, value: unknown) =>
        dataSource.query(
          `INSERT INTO document_sealing_jobs (document_id, seal_type, phase, ${column}) VALUES ($1, 'ADVANCED', 'VERIFYING_OCSP', $2)`,
          [documentId, value],
        );

      await expect(insert('attempt_count', -1)).rejects.toThrow(
        /CHK_document_sealing_jobs_attempt_count/,
      );
      await expect(insert('status', 'FAILED')).rejects.toThrow(
        /CHK_document_sealing_jobs_status/,
      );
      await expect(
        dataSource.query(
          `INSERT INTO document_sealing_jobs (document_id, seal_type, phase) VALUES ($1, 'BIOMETRIC', 'VERIFYING_OCSP')`,
          [documentId],
        ),
      ).rejects.toThrow(/CHK_document_sealing_jobs_seal_type/);
      await expect(
        dataSource.query(
          `INSERT INTO document_sealing_jobs (document_id, seal_type, phase) VALUES ($1, 'ADVANCED', 'SEALING')`,
          [documentId],
        ),
      ).rejects.toThrow(/CHK_document_sealing_jobs_phase/);
    });

    /**
     * Revierte migraciones desde la última hasta `name` incluida, sin suponer que sea la última:
     * las que vengan después se revierten primero, como lo haría un rollback real.
     */
    async function undoMigrationsThrough(name: string): Promise<void> {
      for (;;) {
        const [last] = await dataSource.query(
          `SELECT name FROM migrations ORDER BY id DESC LIMIT 1`,
        );
        await dataSource.undoLastMigration({ transaction: 'each' });
        if (last.name === name) {
          return;
        }
      }
    }

    it('la migración se revierte y se vuelve a aplicar', async () => {
      const applied = await dataSource.query(
        `SELECT name FROM migrations WHERE name = 'CreateDocumentSealingJobs1784300000099'`,
      );
      expect(applied).toHaveLength(1);

      await undoMigrationsThrough('CreateDocumentSealingJobs1784300000099');
      const [{ exists }] = await dataSource.query(
        `SELECT to_regclass('public.document_sealing_jobs') IS NOT NULL AS exists`,
      );
      expect(exists).toBe(false);

      await dataSource.runMigrations({ transaction: 'each' });
      expect(await jobsOf(randomUUID())).toEqual([]);
    });

    it('verification_record_digest sólo acepta un SHA-256 hex y su migración se revierte', async () => {
      const { documentId } = await createDocumentWithFielSigner();
      await dataSource.query(
        `INSERT INTO document_seals (document_id, signature_hash, canonical_payload, timestamp_evidence, integrity_evidence)
         VALUES ($1, 'hash', 'cadena', '{}', '{}')`,
        [documentId],
      );
      const setDigest = (value: string | null) =>
        dataSource.query(
          `UPDATE document_seals SET verification_record_digest = $2 WHERE document_id = $1`,
          [documentId, value],
        );

      await expect(setDigest('a'.repeat(64))).resolves.toBeDefined();
      await expect(setDigest(null)).resolves.toBeDefined();
      for (const invalid of ['A'.repeat(64), 'a'.repeat(63), 'g'.repeat(64)]) {
        await expect(setDigest(invalid)).rejects.toThrow(
          /CHK_document_seals_verification_record_digest/,
        );
      }

      await undoMigrationsThrough(
        'AddVerificationRecordDigestToDocumentSeals1784300000100',
      );
      const columnsAfterUndo = await dataSource.query(
        `SELECT column_name FROM information_schema.columns
          WHERE table_name = 'document_seals' AND column_name = 'verification_record_digest'`,
      );
      expect(columnsAfterUndo).toEqual([]);

      await dataSource.runMigrations({ transaction: 'each' });
      const [column] = await dataSource.query(
        `SELECT data_type, character_maximum_length, is_nullable FROM information_schema.columns
          WHERE table_name = 'document_seals' AND column_name = 'verification_record_digest'`,
      );
      expect(column).toEqual({
        data_type: 'character varying',
        character_maximum_length: 64,
        is_nullable: 'YES',
      });
    });
  });

  describe('registro dentro de la transacción de cierre', () => {
    it('registra un solo trabajo PENDING en VERIFYING_OCSP y la evidencia FIEL queda junto a él', async () => {
      const { documentId, collaboratorId } =
        await createDocumentWithFielSigner();

      const { job, created } = await dataSource.transaction((manager) =>
        closeDocument(manager, documentId, collaboratorId),
      );

      expect(created).toBe(true);
      expect(job).toEqual(
        expect.objectContaining({
          documentId,
          status: SEALING_JOB_STATUS_ENUM.PENDING,
          phase: SEALING_PHASE_ENUM.VERIFYING_OCSP,
          sealType: SEALING_TYPE_ENUM.ADVANCED,
          attemptCount: 0,
          requestObjectKey: null,
        }),
      );
      expect(job.nextAttemptAt).toBeInstanceOf(Date);
      expect(await jobsOf(documentId)).toHaveLength(1);

      // Lo que el worker leerá: la firma del último firmante ya está en la base.
      const [collaborator] = await dataSource.query(
        `SELECT advanced_signature FROM collaborators WHERE id = $1`,
        [collaboratorId],
      );
      expect(collaborator.advanced_signature).toEqual(ADVANCED_SIGNATURE);
    });

    it('si la transacción falla, no queda el trabajo, ni la evidencia, ni el documento cerrado', async () => {
      const { documentId, collaboratorId } =
        await createDocumentWithFielSigner();

      await expect(
        dataSource.transaction(async (manager) => {
          await closeDocument(manager, documentId, collaboratorId);
          throw new Error('fallo al consumir las reservas');
        }),
      ).rejects.toThrow('fallo al consumir las reservas');

      expect(await jobsOf(documentId)).toEqual([]);
      const [document] = await dataSource.query(
        `SELECT status, sealing_pending_at FROM documents WHERE id = $1`,
        [documentId],
      );
      expect(document).toEqual({
        status: 'PENDING_SIGNATURE',
        sealing_pending_at: null,
      });
      const [collaborator] = await dataSource.query(
        `SELECT advanced_signature FROM collaborators WHERE id = $1`,
        [collaboratorId],
      );
      expect(collaborator.advanced_signature).toBeNull();
    });

    it('dos registros concurrentes del mismo documento dejan un solo trabajo', async () => {
      const { documentId } = await createDocumentWithFielSigner();
      const register = () =>
        dataSource.transaction(async (manager) => {
          const result = await registerSealingJob.execute(
            { documentId, sealType: SEALING_TYPE_ENUM.ADVANCED },
            manager,
          );
          // Mantiene la transacción abierta para que la otra choque contra la fila sin confirmar.
          await manager.query('SELECT pg_sleep(0.2)');
          return result;
        });

      const results = await Promise.all([register(), register()]);

      expect(results.map(({ created }) => created).sort()).toEqual([
        false,
        true,
      ]);
      expect(results[0].job.id).toBe(results[1].job.id);
      expect(await jobsOf(documentId)).toHaveLength(1);
    });

    it('repetir el registro devuelve el trabajo existente sin reiniciar sus intentos ni reabrirlo', async () => {
      const { documentId } = await createDocumentWithFielSigner();
      await dataSource.transaction((manager) =>
        registerSealingJob.execute(
          { documentId, sealType: SEALING_TYPE_ENUM.ADVANCED },
          manager,
        ),
      );
      await dataSource.query(
        `UPDATE document_sealing_jobs SET status = 'COMPLETED', phase = 'UPDATING_EVIDENCE_PDF', attempt_count = 3, completed_at = now() WHERE document_id = $1`,
        [documentId],
      );

      const { job, created } = await dataSource.transaction((manager) =>
        registerSealingJob.execute(
          {
            documentId,
            sealType: SEALING_TYPE_ENUM.ADVANCED,
            request: {
              objectKey: `${documentId}/otro.json`,
              hash: 'b'.repeat(64),
            },
          },
          manager,
        ),
      );

      expect(created).toBe(false);
      expect(job).toEqual(
        expect.objectContaining({
          status: SEALING_JOB_STATUS_ENUM.COMPLETED,
          phase: SEALING_PHASE_ENUM.UPDATING_EVIDENCE_PDF,
          attemptCount: 3,
          requestObjectKey: null,
        }),
      );
    });

    it('un trabajo bloqueado nace en RECONCILIATION_REQUIRED con su diagnóstico', async () => {
      const { documentId } = await createDocumentWithFielSigner();

      const { job } = await dataSource.transaction((manager) =>
        registerSealingJob.execute(
          {
            documentId,
            sealType: SEALING_TYPE_ENUM.SIMPLE,
            blocker: {
              code: 'SIMPLE_EVIDENCE_INCOMPLETE',
              message: 'falta la CURP del firmante c-1',
            },
          },
          manager,
        ),
      );

      expect(job).toEqual(
        expect.objectContaining({
          status: SEALING_JOB_STATUS_ENUM.RECONCILIATION_REQUIRED,
          phase: SEALING_PHASE_ENUM.GENERATING_SEAL,
          lastErrorCode: 'SIMPLE_EVIDENCE_INCOMPLETE',
        }),
      );
    });

    it('borrar el documento borra su trabajo', async () => {
      const { documentId } = await createDocumentWithFielSigner();
      await dataSource.transaction((manager) =>
        registerSealingJob.execute(
          { documentId, sealType: SEALING_TYPE_ENUM.ADVANCED },
          manager,
        ),
      );

      await dataSource.query(
        `DELETE FROM collaborators WHERE document_id = $1`,
        [documentId],
      );
      await dataSource.query(`DELETE FROM documents WHERE id = $1`, [
        documentId,
      ]);

      expect(await jobsOf(documentId)).toEqual([]);
    });
  });

  /**
   * El procesador contra la base real: lo que los dobles no prueban es que los `UPDATE`
   * condicionados al `lease_token` y la transacción de cierre funcionen en Postgres. Sólo se
   * simulan la consulta al SAT, Seal Service, MinIO y la hoja del PDF.
   */
  describe('procesador de trabajos', () => {
    const LEASE = randomUUID();
    const OCSP_EVIDENCE = {
      status: 'good' as const,
      verifiedAt: new Date('2026-11-19T19:00:00.000Z'),
      ocspResponse: 'respuesta-ocsp',
      ocspUrl: 'https://cfdi.sat.gob.mx/edofiel',
    };
    const SEAL_RESPONSE = {
      documentId: 'ignorado',
      hashHex: 'f00d',
      hashAlgorithm: 'sha256',
      hashVersion: 'v1',
      canonicalString: 'v1||canonica',
      sealedAt: '2026-11-19T19:05:00.000Z',
      timeStamp: {
        status: true,
        hashProcessed: 'f00d',
        fileBase64: 'tsr',
        uuid: 'ts',
      },
      nom151: {
        status: true,
        hashProcessed: 'f00d',
        file: 'nom',
        uuid: 'nom',
        pdfFile: 'pdf',
      },
    };

    let sealApi: { generateDocumentSeals: jest.Mock };
    let refresher: { refresh: jest.Mock };
    let processor: ProcessDocumentSealingJobUseCase;

    beforeEach(() => {
      const stored = new Map<string, Buffer>();
      const minio = {
        putSensitiveObject: async (_: unknown, key: string, content: Buffer) =>
          void stored.set(key, Buffer.from(content)),
        getSensitiveObject: async (_: unknown, key: string) => stored.get(key)!,
        removeSensitiveObject: async (_: unknown, key: string) =>
          void stored.delete(key),
      };
      const collaborators = dataSource.getRepository(CollaboratorEntity);
      const retryPendingSeal = new RetryPendingSealUseCase(
        collaborators,
        {} as never,
        {} as never,
      );
      // Sólo la consulta al SAT es doble: guardar y recargar la evidencia es real.
      jest
        .spyOn(retryPendingSeal as never, 'obtainOcspEvidence' as never)
        .mockResolvedValue(OCSP_EVIDENCE as never);

      sealApi = {
        generateDocumentSeals: jest.fn().mockResolvedValue(SEAL_RESPONSE),
      };
      refresher = { refresh: jest.fn().mockResolvedValue(undefined) };
      processor = new ProcessDocumentSealingJobUseCase(
        dataSource.getRepository(DocumentSealingJobEntity),
        dataSource.getRepository(DocumentEntity),
        dataSource.getRepository(SealEntity),
        retryPendingSeal,
        new SealingRequestSnapshotService(
          dataSource.getRepository(DocumentEntity),
          collaborators,
          dataSource.getRepository(VerificationCodeEntity),
          minio as never,
        ),
        new SealDocumentUseCase(
          sealApi as never,
          dataSource.getRepository(SealEntity),
        ),
        // El de firma simple no participa en estos casos.
        {} as never,
        { getSealOperation: jest.fn() } as never,
      );
      processor.useEvidenceRefresher(refresher);
    });

    /** Documento cerrado con su trabajo, reclamado con `LEASE`. */
    async function claimedJob(): Promise<{
      documentId: string;
      collaboratorId: string;
      jobId: string;
    }> {
      const { documentId, collaboratorId } =
        await createDocumentWithFielSigner();
      await dataSource.query(
        `UPDATE documents SET signed_hash = 'hash-firmado' WHERE id = $1`,
        [documentId],
      );
      const { job } = await dataSource.transaction((manager) =>
        closeDocument(manager, documentId, collaboratorId),
      );
      await dataSource.query(
        `UPDATE document_sealing_jobs SET status = 'PROCESSING', lease_token = $2, lease_expires_at = now() + interval '5 minutes', attempt_count = 1 WHERE id = $1`,
        [job.id, LEASE],
      );
      return { documentId, collaboratorId, jobId: job.id };
    }

    async function stateOf(documentId: string) {
      const [row] = await dataSource.query(
        `SELECT j.status, j.phase, j.lease_token, j.lease_expires_at, j.completed_at, j.request_object_key, j.request_hash,
                d.sealing_pending_at, d.signed_hash, c.advanced_signature,
                (SELECT count(*)::int FROM document_seals s WHERE s.document_id = d.id) AS seals
           FROM document_sealing_jobs j
           JOIN documents d ON d.id = j.document_id
           JOIN collaborators c ON c.document_id = d.id
          WHERE j.document_id = $1`,
        [documentId],
      );
      return row;
    }

    it('completa OCSP, sella con lo persistido y cierra trabajo y pendiente en una transacción', async () => {
      const { documentId, jobId } = await claimedJob();

      await processor.execute(jobId, LEASE);

      const state = await stateOf(documentId);
      expect(state).toEqual(
        expect.objectContaining({
          status: SEALING_JOB_STATUS_ENUM.COMPLETED,
          phase: SEALING_PHASE_ENUM.UPDATING_EVIDENCE_PDF,
          lease_token: null,
          lease_expires_at: null,
          completed_at: expect.any(Date),
          request_object_key: expect.stringContaining(`${documentId}/`),
          request_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
          sealing_pending_at: null,
          // Nada vuelve a firmar ni cambia el hash firmado.
          signed_hash: 'hash-firmado',
          seals: 1,
        }),
      );
      // La evidencia recién guardada es la que viajó, y la fecha de firma no cambió.
      expect(state.advanced_signature.signedAt).toBe(
        ADVANCED_SIGNATURE.signedAt,
      );
      expect(state.advanced_signature.ocspEvidence.verifiedAt).toBe(
        OCSP_EVIDENCE.verifiedAt.toISOString(),
      );
      const [sent] = sealApi.generateDocumentSeals.mock.calls[0];
      expect(sent.signatures[0].ocspEvidence).toEqual({
        status: 'good',
        verifiedAt: OCSP_EVIDENCE.verifiedAt.toISOString(),
        ocspResponse: 'respuesta-ocsp',
        ocspUrl: 'https://cfdi.sat.gob.mx/edofiel',
      });
      expect(refresher.refresh).toHaveBeenCalledWith(
        documentId,
        expect.objectContaining({ documentId, signatureHash: 'f00d' }),
      );
    });

    it('un fallo del PDF deja el trabajo en esa fase con el pendiente, y el reintento no vuelve a sellar', async () => {
      const { documentId, jobId } = await claimedJob();
      refresher.refresh
        .mockRejectedValueOnce(new SealedEvidencePdfUpdateException())
        .mockResolvedValueOnce(undefined);

      await expect(processor.execute(jobId, LEASE)).rejects.toBeInstanceOf(
        DocumentSealingJobFailedException,
      );
      expect(await stateOf(documentId)).toEqual(
        expect.objectContaining({
          status: SEALING_JOB_STATUS_ENUM.PROCESSING,
          phase: SEALING_PHASE_ENUM.UPDATING_EVIDENCE_PDF,
          sealing_pending_at: expect.any(Date),
          seals: 1,
        }),
      );

      await processor.execute(jobId, LEASE);

      expect(sealApi.generateDocumentSeals).toHaveBeenCalledTimes(1);
      expect((await stateOf(documentId)).status).toBe(
        SEALING_JOB_STATUS_ENUM.COMPLETED,
      );
    });

    it('si otro worker recuperó el trabajo, no escribe nada', async () => {
      const { documentId, jobId } = await claimedJob();
      await dataSource.query(
        `UPDATE document_sealing_jobs SET lease_token = $2 WHERE id = $1`,
        [jobId, randomUUID()],
      );

      await expect(processor.execute(jobId, LEASE)).rejects.toBeInstanceOf(
        SealingJobLeaseLostException,
      );
      expect(await stateOf(documentId)).toEqual(
        expect.objectContaining({
          status: SEALING_JOB_STATUS_ENUM.PROCESSING,
          phase: SEALING_PHASE_ENUM.VERIFYING_OCSP,
          sealing_pending_at: expect.any(Date),
          seals: 0,
        }),
      );
      expect(sealApi.generateDocumentSeals).not.toHaveBeenCalled();
    });
  });

  it('el repositorio lee la entidad con sus tipos', async () => {
    const { documentId } = await createDocumentWithFielSigner();
    await dataSource.transaction((manager) =>
      registerSealingJob.execute(
        { documentId, sealType: SEALING_TYPE_ENUM.ADVANCED },
        manager,
      ),
    );

    const job = await dataSource
      .getRepository(DocumentSealingJobEntity)
      .findOneByOrFail({ documentId });

    expect(job.createdAt).toBeInstanceOf(Date);
    expect(job.leaseToken).toBeNull();
    expect(job.leaseExpiresAt).toBeNull();
  });

  /**
   * Reclamo, lease y recuperación contra Postgres: `FOR UPDATE SKIP LOCKED`, los UPDATE
   * condicionados al token y el barrido de trabajos agotados sólo se prueban de verdad aquí.
   */
  describe('worker: reclamo y lease', () => {
    const config = {
      settings: { ...DEFAULT_SEALING_WORKER_SETTINGS, maxAttempts: 8 },
    } as SealingWorkerConfig;
    let claim: ClaimDueSealingJobsUseCase;
    let leases: SealingJobLeaseService;

    beforeEach(async () => {
      // Cada caso parte sin trabajos de los bloques anteriores.
      await dataSource.query(`DELETE FROM document_sealing_jobs`);
      claim = new ClaimDueSealingJobsUseCase(dataSource, config);
      leases = new SealingJobLeaseService(
        dataSource.getRepository(DocumentSealingJobEntity),
        config,
      );
    });

    /** Documento con un trabajo en el estado indicado. */
    async function jobIn(
      status: SEALING_JOB_STATUS_ENUM,
      extra: string = '',
    ): Promise<string> {
      const { documentId } = await createDocumentWithFielSigner();
      const { job } = await dataSource.transaction((manager) =>
        registerSealingJob.execute(
          { documentId, sealType: SEALING_TYPE_ENUM.ADVANCED },
          manager,
        ),
      );
      await dataSource.query(
        `UPDATE document_sealing_jobs SET status = $2 ${extra} WHERE id = $1`,
        [job.id, status],
      );
      return job.id;
    }

    async function rowOf(jobId: string) {
      const [row] = await dataSource.query(
        `SELECT status, phase, attempt_count, lease_token, lease_expires_at, next_attempt_at,
                last_error_code, last_upstream_status
           FROM document_sealing_jobs WHERE id = $1`,
        [jobId],
      );
      return row;
    }

    it('dos workers reclamando a la vez nunca toman el mismo trabajo', async () => {
      const ids = [];
      for (let i = 0; i < 6; i++) {
        ids.push(await jobIn(SEALING_JOB_STATUS_ENUM.PENDING));
      }

      const [first, second] = await Promise.all([
        claim.execute(6),
        claim.execute(6),
      ]);

      const claimed = [...first, ...second].map((job) => job.id);
      expect(new Set(claimed).size).toBe(claimed.length);
      expect(claimed.sort()).toEqual([...ids].sort());
      for (const job of [...first, ...second]) {
        expect(await rowOf(job.id)).toEqual(
          expect.objectContaining({
            status: SEALING_JOB_STATUS_ENUM.PROCESSING,
            attempt_count: 1,
            lease_token: job.leaseToken,
            lease_expires_at: expect.any(Date),
          }),
        );
      }
    });

    it('cada trabajo reclamado recibe su propio token y respeta el límite', async () => {
      await jobIn(SEALING_JOB_STATUS_ENUM.PENDING);
      await jobIn(SEALING_JOB_STATUS_ENUM.PENDING);
      await jobIn(SEALING_JOB_STATUS_ENUM.PENDING);

      const claimed = await claim.execute(2);

      expect(claimed).toHaveLength(2);
      expect(claimed[0].leaseToken).not.toBe(claimed[1].leaseToken);
    });

    it('respeta next_attempt_at y nunca toma trabajos terminales ni en conciliación', async () => {
      await jobIn(
        SEALING_JOB_STATUS_ENUM.RETRY_SCHEDULED,
        `, next_attempt_at = now() + interval '5 minutes'`,
      );
      await jobIn(SEALING_JOB_STATUS_ENUM.DEAD);
      await jobIn(SEALING_JOB_STATUS_ENUM.COMPLETED);
      await jobIn(SEALING_JOB_STATUS_ENUM.RECONCILIATION_REQUIRED);
      const due = await jobIn(
        SEALING_JOB_STATUS_ENUM.RETRY_SCHEDULED,
        `, next_attempt_at = now() - interval '1 second', attempt_count = 2`,
      );

      const claimed = await claim.execute(10);

      expect(claimed.map((job) => job.id)).toEqual([due]);
      expect(claimed[0].attemptCount).toBe(3);
    });

    it('recupera un PROCESSING con el lease vencido, pero no uno vigente', async () => {
      const expired = await jobIn(
        SEALING_JOB_STATUS_ENUM.PROCESSING,
        `, lease_token = gen_random_uuid(), lease_expires_at = now() - interval '1 second', attempt_count = 1`,
      );
      await jobIn(
        SEALING_JOB_STATUS_ENUM.PROCESSING,
        `, lease_token = gen_random_uuid(), lease_expires_at = now() + interval '1 minute', attempt_count = 1`,
      );
      const before = await rowOf(expired);

      const claimed = await claim.execute(10);

      expect(claimed).toEqual([
        expect.objectContaining({
          id: expired,
          recovered: true,
          attemptCount: 2,
        }),
      ]);
      expect(claimed[0].leaseToken).not.toBe(before.lease_token);
    });

    it('un trabajo interrumpido en su última ejecución queda DEAD, no colgado', async () => {
      const exhausted = await jobIn(
        SEALING_JOB_STATUS_ENUM.PROCESSING,
        `, lease_token = gen_random_uuid(), lease_expires_at = now() - interval '1 second', attempt_count = 8, phase = 'GENERATING_SEAL'`,
      );

      expect(await claim.execute(10)).toEqual([]);
      expect(await rowOf(exhausted)).toEqual(
        expect.objectContaining({
          status: SEALING_JOB_STATUS_ENUM.DEAD,
          // Se conserva la fase en la que se quedó.
          phase: SEALING_PHASE_ENUM.GENERATING_SEAL,
          lease_token: null,
          last_error_code: 'MAX_ATTEMPTS_REACHED',
        }),
      );
    });

    it('renovar extiende el lease sólo para el dueño', async () => {
      await jobIn(SEALING_JOB_STATUS_ENUM.PENDING);
      const [job] = await claim.execute(1);
      await dataSource.query(
        `UPDATE document_sealing_jobs SET lease_expires_at = now() + interval '5 seconds' WHERE id = $1`,
        [job.id],
      );

      expect(await leases.renew(job.id, randomUUID())).toBe(false);
      expect(await leases.renew(job.id, job.leaseToken)).toBe(true);

      const { lease_expires_at } = await rowOf(job.id);
      expect(new Date(lease_expires_at).getTime()).toBeGreaterThan(
        Date.now() + 100_000,
      );
    });

    it('un worker antiguo no puede renovar, reprogramar ni completar el trabajo del nuevo dueño', async () => {
      await jobIn(SEALING_JOB_STATUS_ENUM.PENDING);
      const [old] = await claim.execute(1);
      // Su lease vence y otro worker lo recupera.
      await dataSource.query(
        `UPDATE document_sealing_jobs SET lease_expires_at = now() - interval '1 second' WHERE id = $1`,
        [old.id],
      );
      const [current] = await claim.execute(1);
      expect(current.id).toBe(old.id);

      const failure = classifySealingError(
        new SealProviderUnavailableException(),
        SEALING_PHASE_ENUM.VERIFYING_OCSP,
      );
      const decision = decideSealingRetry({
        attemptCount: old.attemptCount,
        failure,
        maxAttempts: 8,
      });

      expect(await leases.renew(old.id, old.leaseToken)).toBe(false);
      expect(
        await leases.recordFailure(old.id, old.leaseToken, decision, failure),
      ).toBe(false);
      const processor = new ProcessDocumentSealingJobUseCase(
        dataSource.getRepository(DocumentSealingJobEntity),
        dataSource.getRepository(DocumentEntity),
        dataSource.getRepository(SealEntity),
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
      );
      await expect(
        processor.execute(old.id, old.leaseToken),
      ).rejects.toBeInstanceOf(SealingJobLeaseLostException);

      expect(await rowOf(current.id)).toEqual(
        expect.objectContaining({
          status: SEALING_JOB_STATUS_ENUM.PROCESSING,
          lease_token: current.leaseToken,
          attempt_count: 2,
        }),
      );
    });

    it('registrar un fallo libera el lease y conserva la fase, con su backoff', async () => {
      await jobIn(
        SEALING_JOB_STATUS_ENUM.PENDING,
        `, phase = 'GENERATING_SEAL'`,
      );
      const [job] = await claim.execute(1);
      const failure = classifySealingError(
        new SealProviderResponseException(429, 10 * 60_000),
        SEALING_PHASE_ENUM.GENERATING_SEAL,
      );
      const decision = decideSealingRetry({
        attemptCount: job.attemptCount,
        failure,
        maxAttempts: 8,
      });

      expect(
        await leases.recordFailure(job.id, job.leaseToken, decision, failure),
      ).toBe(true);

      const row = await rowOf(job.id);
      expect(row).toEqual(
        expect.objectContaining({
          status: SEALING_JOB_STATUS_ENUM.RETRY_SCHEDULED,
          phase: SEALING_PHASE_ENUM.GENERATING_SEAL,
          lease_token: null,
          lease_expires_at: null,
          last_error_code: 'SEAL_PROVIDER_REJECTED',
          last_upstream_status: 429,
        }),
      );
      // Retry-After de 10 min por encima del primer escalón (1 min).
      expect(new Date(row.next_attempt_at).getTime()).toBeGreaterThanOrEqual(
        Date.now() + 9 * 60_000,
      );
      // No se vuelve a reclamar antes de tiempo.
      expect(await claim.execute(10)).toEqual([]);
    });
  });

  describe('recuperación histórica (backfill)', () => {
    const logger = { log: jest.fn(), warn: jest.fn() };
    let snapshots: {
      freezeSimpleSignatureRequest: jest.Mock;
      discard: jest.Mock;
    };

    beforeEach(() => {
      snapshots = {
        freezeSimpleSignatureRequest: jest.fn().mockResolvedValue({
          objectKey: 'doc/snap.json',
          hash: 'a'.repeat(64),
        }),
        discard: jest.fn(),
      };
    });

    const run = (dryRun: boolean) =>
      backfillPendingSealingJobs(
        { dataSource, snapshots, registerJob: registerSealingJob, logger },
        { dryRun, limit: 1000 },
      );

    /** Documento firmado como antes de los trabajos. */
    async function historicalDocument(options: {
      signatureType: 'FIEL' | 'SIMPLE' | 'BIOMETRIC';
      pending?: boolean;
      sealed?: boolean;
    }): Promise<string> {
      const documentId = await insertReturningId(
        `INSERT INTO documents (object_key, file_name, file_type, total_pages, ip_address, original_hash, signed_hash, created_by, account_id, total_signers, status, sealing_pending_at)
         VALUES ($1, 'historico.pdf', 'application/pdf', 1, '127.0.0.1', 'hash', 'hash-firmado', $2, $3, 1, 'SIGNED', $4)`,
        [
          `${randomUUID()}.pdf`,
          ids.user,
          ids.account,
          options.pending === false ? null : new Date('2026-09-01T00:00:00Z'),
        ],
      );
      await dataSource.query(
        `INSERT INTO collaborators (document_id, ip_address, colaborator_type, signature_type, status) VALUES ($1, '127.0.0.1', 'SIGNER', $2, 'SIGNED')`,
        [documentId, options.signatureType],
      );
      if (options.sealed) {
        await dataSource.query(
          `INSERT INTO document_seals (document_id, signature_hash, canonical_payload, timestamp_evidence, integrity_evidence) VALUES ($1, 'h', 'c', '{}', '{}')`,
          [documentId],
        );
      }
      return documentId;
    }

    const outcomeOf = (
      summary: Awaited<ReturnType<typeof run>>,
      documentId: string,
    ) => summary.documents.find((doc) => doc.documentId === documentId);

    it('--dry-run informa sin escribir; la corrida real registra y repetirla no duplica', async () => {
      const advanced = await historicalDocument({ signatureType: 'FIEL' });
      const simple = await historicalDocument({ signatureType: 'SIMPLE' });

      const dry = await run(true);
      expect(outcomeOf(dry, advanced)?.outcome).toBe('WOULD_REGISTER');
      expect(outcomeOf(dry, simple)?.outcome).toBe('WOULD_REGISTER');
      expect(await jobsOf(advanced)).toEqual([]);
      expect(snapshots.freezeSimpleSignatureRequest).not.toHaveBeenCalled();

      const real = await run(false);
      expect(outcomeOf(real, advanced)?.outcome).toBe('REGISTERED');
      expect(outcomeOf(real, simple)?.outcome).toBe('REGISTERED');
      expect(await jobsOf(advanced)).toEqual([
        expect.objectContaining({ status: 'PENDING', phase: 'VERIFYING_OCSP' }),
      ]);
      expect(await jobsOf(simple)).toEqual([
        expect.objectContaining({
          status: 'PENDING',
          phase: 'GENERATING_SEAL',
          request_object_key: 'doc/snap.json',
        }),
      ]);

      const again = await run(false);
      expect(outcomeOf(again, advanced)).toBeUndefined();
      expect(outcomeOf(again, simple)).toBeUndefined();
      expect(await jobsOf(advanced)).toHaveLength(1);
    });

    it('no toma documentos sin la marca de pendiente ni los que ya tienen constancia', async () => {
      const unmarked = await historicalDocument({
        signatureType: 'FIEL',
        pending: false,
      });
      const sealed = await historicalDocument({
        signatureType: 'FIEL',
        sealed: true,
      });

      const summary = await run(false);

      expect(outcomeOf(summary, unmarked)).toBeUndefined();
      expect(outcomeOf(summary, sealed)).toBeUndefined();
      expect(await jobsOf(unmarked)).toEqual([]);
      expect(await jobsOf(sealed)).toEqual([]);
    });

    it('un documento sin contrato de sellado se informa como no elegible', async () => {
      const biometric = await historicalDocument({
        signatureType: 'BIOMETRIC',
      });

      const summary = await run(false);

      expect(outcomeOf(summary, biometric)).toEqual(
        expect.objectContaining({
          outcome: 'NOT_ELIGIBLE',
          reason: 'NO_SEALING_CONTRACT',
        }),
      );
      expect(await jobsOf(biometric)).toEqual([]);
    });

    it('una firma simple sin evidencia completa nace en conciliación', async () => {
      const simple = await historicalDocument({ signatureType: 'SIMPLE' });
      snapshots.freezeSimpleSignatureRequest.mockRejectedValue(
        new IncompleteSimpleSignatureDataException('la INE', 'c-1'),
      );

      const summary = await run(false);

      expect(outcomeOf(summary, simple)).toEqual(
        expect.objectContaining({
          outcome: 'REGISTERED_BLOCKED',
          reason: 'SIMPLE_EVIDENCE_INCOMPLETE',
        }),
      );
      expect(await jobsOf(simple)).toEqual([
        expect.objectContaining({ status: 'RECONCILIATION_REQUIRED' }),
      ]);
    });
  });
});
