import { createHash, randomUUID } from 'crypto';
import { PDFDocument } from 'pdf-lib';
import { DataSource, QueryFailedError, Repository } from 'typeorm';

import { HashService } from './../src/common/hash/hash.service';
import { BUCKET_TYPES_ENUM } from './../src/common/minio/enums/bucket-types.enum';
import { PdfSignatureService } from './../src/common/document-signing/document-signing.service';
import { GetPublicDocumentUseCase } from './../src/document/applications/get-public-document.use-case';
import { DocumentService } from './../src/document/document.service';
import { DocumentAuditXmlService } from './../src/document/audit-xml/document-audit-xml.service';
import { RecordVerificationRecordDigestUseCase } from './../src/document/audit-xml/record-verification-record-digest.use-case';
import { CollaboratorEntity } from './../src/document/entities/collaborator.entity';
import { DocumentEntity } from './../src/document/entities/document.entity';
import { VerificationCodeEntity } from './../src/document/entities/verification-code.entity';
import { PUBLIC_SEALING_STATUS_ENUM } from './../src/document/interfaces/responses/document-public-view-response';
import {
  DEFAULT_SEALING_WORKER_SETTINGS,
  SealingWorkerConfig,
  SealingWorkerSettings,
} from './../src/document/seal/config/sealing-worker.config';
import { DocumentSealingJobEntity } from './../src/document/seal/entities/document-sealing-job.entity';
import { SealEntity } from './../src/document/seal/entities/seal.entity';
import { SEALING_TYPE_ENUM } from './../src/document/seal/enums/sealing-type.enum';
import { DocumentSealingJobFailedException } from './../src/document/seal/exceptions/seal.exceptions';
import { ProcessPendingSealingJobsJob } from './../src/document/seal/jobs/process-pending-sealing-jobs.job';
import { SealingRetryPolicy } from './../src/document/seal/policies/sealing-retry.policy';
import { SealApiService } from './../src/document/seal/services/seal-api.service';
import { SealingJobLeaseService } from './../src/document/seal/services/sealing-job-lease.service';
import { SealingRequestSnapshotService } from './../src/document/seal/services/sealing-request-snapshot.service';
import { ClaimDueSealingJobsUseCase } from './../src/document/seal/use-cases/claim-due-sealing-jobs.use-case';
import { ProcessDocumentSealingJobUseCase } from './../src/document/seal/use-cases/process-document-sealing-job.use-case';
import { RegisterDocumentSealingJobUseCase } from './../src/document/seal/use-cases/register-document-sealing-job.use-case';
import { RetryPendingSealUseCase } from './../src/document/seal/use-cases/retry-pending-seal.use-case';
import { SealDocumentUseCase } from './../src/document/seal/use-cases/seal-document.use-case';
import { SendCompletedSimpleSignatureToSealUseCase } from './../src/document/seal/use-cases/send-completed-simple-signature-to-seal.use-case';
import { RefreshSealedDocumentEvidenceService } from './../src/document/services/refresh-sealed-document-evidence.service';
import { AdvancedSummaryDocumentService } from './../src/document/summary-document/advanced-summary-document.service';
import { SummaryDocumentService } from './../src/document/summary-document/summary-document.service';
import { InMemoryMinio } from './fixtures/sealing/minio.stub';
import {
  ControlledOcspResponder,
  controlledEfirma,
} from './fixtures/sealing/ocsp.stub';
import {
  SealProviderStub,
  STUB_SEAL_API_KEY,
} from './fixtures/sealing/seal-provider.stub';
import { SealingTestDatabase } from './fixtures/sealing/sealing-test-database';
import {
  TEST_CERTIFICATE_PEM_1,
  TEST_CERTIFICATE_PEM_2,
} from './fixtures/sealing/test-certificates';

/**
 * Flujo completo de sellado con proveedores controlados: Postgres real (base aislada), un servidor
 * HTTP con el contrato idempotente de Seal Service y un adaptador OCSP programable. Ni el SAT ni el
 * PSC reales participan.
 *
 * Todo lo demás es el código de producción: worker, reclamo, lease, política de reintentos,
 * procesador, cliente HTTP, snapshots, mapper y la hoja de evidencia real (pdfmake + pdf-lib).
 * El "paso del tiempo" entre reintentos se simula adelantando `next_attempt_at`.
 */
/** PDF original sin firmar que el XML de auditoría incluye; su contenido no importa al sellado. */
const ORIGINAL_PDF = Buffer.from('%PDF-1.7 original');

describe('Sellado de documentos: recuperación con proveedores controlados (e2e)', () => {
  const db = new SealingTestDatabase('signature_sealing_e2e');
  let provider: SealProviderStub;
  let ocsp: ControlledOcspResponder;
  let minio: InMemoryMinio;
  let sealSaveFailures: number;
  let summarySpy: jest.SpyInstance;
  const registerJob = new RegisterDocumentSealingJobUseCase();

  beforeAll(async () => {
    await db.create();
    provider = await SealProviderStub.start();
  }, 180_000);

  afterAll(async () => {
    await provider?.stop();
    await db.destroy();
  });

  beforeEach(async () => {
    // Cada caso parte sin trabajos pendientes de los anteriores.
    await db.dataSource.query(`DELETE FROM document_sealing_jobs`);
    provider.reset();
    ocsp = new ControlledOcspResponder();
    minio = new InMemoryMinio();
    sealSaveFailures = 0;
    summarySpy?.mockRestore();
    summarySpy = jest.spyOn(
      AdvancedSummaryDocumentService.prototype,
      'generateAdvancedSummaryPdf',
    );
  });

  /**
   * Arma un worker completo sobre una conexión (cada "instancia" puede tener la suya).
   *
   * @param dataSource - Conexión a la base aislada.
   * @param overrides - Configuración del worker.
   * @returns El cron y el procesador.
   */
  function buildWorker(
    dataSource: DataSource = db.dataSource,
    overrides: Partial<SealingWorkerSettings> = {},
  ) {
    const config = {
      settings: {
        ...DEFAULT_SEALING_WORKER_SETTINGS,
        enabled: true,
        ...overrides,
      },
    } as SealingWorkerConfig;
    const jobs = dataSource.getRepository(DocumentSealingJobEntity);
    const documents = dataSource.getRepository(DocumentEntity);
    const collaborators = dataSource.getRepository(CollaboratorEntity);
    const seals = flakySealRepository(dataSource.getRepository(SealEntity));
    const sealApi = new SealApiService({
      get: (key: string) =>
        ({
          SEAL_SERVICE_URL: provider.url,
          SEAL_SERVICE_API_KEY: STUB_SEAL_API_KEY,
        })[key],
    } as never);

    const processor = new ProcessDocumentSealingJobUseCase(
      jobs,
      documents,
      seals,
      new RetryPendingSealUseCase(
        collaborators,
        controlledEfirma as never,
        ocsp as never,
      ),
      snapshotsFor(dataSource),
      new SealDocumentUseCase(sealApi, seals),
      new SendCompletedSimpleSignatureToSealUseCase(
        seals,
        minio as never,
        sealApi,
      ),
      sealApi,
    );
    new RefreshSealedDocumentEvidenceService(
      documentServiceFor(dataSource) as never,
      collaborators,
      minio as never,
      new HashService(),
      processor,
      digestRecorderFor(dataSource, new SealDocumentUseCase(sealApi, seals)),
    ).onModuleInit();

    const worker = new ProcessPendingSealingJobsJob(
      config,
      new ClaimDueSealingJobsUseCase(dataSource, config),
      processor,
      new SealingJobLeaseService(jobs, config),
      new SealingRetryPolicy(config),
    );
    return { worker, processor, config };
  }

  /**
   * `RecordVerificationRecordDigestUseCase` real: arma el XML de auditoría desde la base y el MinIO
   * en memoria y guarda su digest en `document_seals`.
   */
  function digestRecorderFor(
    dataSource: DataSource,
    sealDocument: SealDocumentUseCase,
  ) {
    return new RecordVerificationRecordDigestUseCase(
      auditXmlFor(dataSource, sealDocument),
      sealDocument,
    );
  }

  function auditXmlFor(
    dataSource: DataSource,
    sealDocument: SealDocumentUseCase,
  ) {
    return new DocumentAuditXmlService(
      dataSource.getRepository(CollaboratorEntity),
      documentServiceFor(dataSource),
      minio as never,
      sealDocument,
    );
  }

  /** Digest guardado y el que da volver a armar el XML con la evidencia actual. */
  async function verificationRecordDigests(documentId: string) {
    const seals = db.dataSource.getRepository(SealEntity);
    const seal = await seals.findOneByOrFail({ documentId });
    const rebuilt = await auditXmlFor(
      db.dataSource,
      new SealDocumentUseCase({} as never, seals),
    ).build(documentId, { seal });
    return {
      stored: seal.verificationRecordDigest,
      rebuilt: sha256(Buffer.from(rebuilt, 'utf8')),
    };
  }

  /** `DocumentService` real sólo en lo que usa la hoja: generadores y PDF reales, MinIO en memoria. */
  function documentServiceFor(dataSource: DataSource): DocumentService {
    return Object.assign(Object.create(DocumentService.prototype), {
      documentRepository: dataSource.getRepository(DocumentEntity),
      userService: {
        findOne: async () => ({ email: 'creadora@correo.example' }),
      },
      minioService: minio,
      documentSigningSerivice: new PdfSignatureService(),
      summaryDocumentService: new SummaryDocumentService(),
      advancedSummaryDocumentService: new AdvancedSummaryDocumentService(),
      verificationCodeService: { findConsumedCode: async () => null },
    }) as DocumentService;
  }

  function snapshotsFor(dataSource: DataSource) {
    return new SealingRequestSnapshotService(
      dataSource.getRepository(DocumentEntity),
      dataSource.getRepository(CollaboratorEntity),
      dataSource.getRepository(VerificationCodeEntity),
      minio as never,
    );
  }

  /** Repositorio real de constancias cuyo `save` falla `sealSaveFailures` veces (BD caída). */
  function flakySealRepository(
    repository: Repository<SealEntity>,
  ): Repository<SealEntity> {
    return new Proxy(repository, {
      get(target, property, receiver) {
        if (property === 'save') {
          return async (...args: unknown[]) => {
            if (sealSaveFailures > 0) {
              sealSaveFailures -= 1;
              throw new QueryFailedError('INSERT INTO document_seals', [], {
                code: '57P01',
              } as unknown as Error);
            }
            return (target.save as (...a: unknown[]) => unknown)(...args);
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  }

  /** PDF firmado de una página, como lo deja el cierre en `signed_documents`. */
  async function signedPdf(): Promise<Buffer> {
    const pdf = await PDFDocument.create();
    pdf.addPage([612, 792]).drawText('Contrato firmado', { x: 72, y: 700 });
    return Buffer.from(await pdf.save());
  }

  const sha256 = (content: Buffer) =>
    createHash('sha256').update(content).digest('hex');

  /** Firma avanzada persistida; nunca lleva llave privada ni contraseña. */
  function advancedSignature(pem: string, index: number, withOcsp: boolean) {
    return {
      originalHash: 'hash-original',
      signatureBase64: `firma-${index}`,
      algorithm: 'sha256',
      signedAt: `2026-11-19T1${index}:00:00.000Z`,
      certificate: {
        rfc: `XAXX01010${index}000`,
        name: `FIRMANTE ${index}`,
        issuer: 'AC DE PRUEBA',
        serialNumber: `0000${index}`,
        certificateNumber: `3000${index}`,
        certificatePem: pem,
      },
      ...(withOcsp && {
        ocspEvidence: {
          status: 'good',
          verifiedAt: `2026-11-19T1${index}:00:01.000Z`,
          ocspResponse: `ocsp-al-firmar-${index}`,
          ocspUrl: 'https://ocsp.test.invalid/edofiel',
        },
      }),
    };
  }

  /**
   * Documento de firma avanzada cerrado, con su PDF firmado en `signed_documents` y su trabajo.
   *
   * @param signers - Certificado de cada firmante y si ya trae OCSP del momento de firmar.
   */
  async function advancedDocument(
    signers: { pem: string; withOcsp: boolean }[],
  ) {
    const pdf = await signedPdf();
    const objectKey = `${randomUUID()}.pdf`;
    minio.write(BUCKET_TYPES_ENUM.SIGNED_DOCUMENTS, objectKey, pdf);
    // El original sin firmar: el XML de auditoría (y su digest) lo exige.
    minio.write(BUCKET_TYPES_ENUM.CREATED_DOCUMENTS, objectKey, ORIGINAL_PDF);
    const documentId = await db.insertDocument({
      objectKey,
      signedHash: sha256(pdf),
      signatureType: 'FIEL',
    });
    for (const [index, signer] of signers.entries()) {
      await db.dataSource.query(
        `INSERT INTO collaborators (document_id, ip_address, colaborator_type, signature_type, status, signing_order, resolved_at, advanced_signature)
         VALUES ($1, '127.0.0.1', 'SIGNER', 'FIEL', 'SIGNED', $2, now(), $3)`,
        [
          documentId,
          index + 1,
          advancedSignature(signer.pem, index + 1, signer.withOcsp),
        ],
      );
    }
    const { job } = await db.dataSource.transaction((manager) =>
      registerJob.execute(
        { documentId, sealType: SEALING_TYPE_ENUM.ADVANCED },
        manager,
      ),
    );
    return { documentId, jobId: job.id, objectKey, pdf };
  }

  async function jobRow(jobId: string) {
    const [row] = await db.dataSource.query(
      `SELECT j.status, j.phase, j.attempt_count, j.lease_token, j.next_attempt_at,
              j.last_error_code, j.last_error_message, j.last_upstream_status, j.request_object_key,
              d.sealing_pending_at, d.signed_hash
         FROM document_sealing_jobs j JOIN documents d ON d.id = j.document_id
        WHERE j.id = $1`,
      [jobId],
    );
    return row;
  }

  async function sealOf(documentId: string) {
    const [row] = await db.dataSource.query(
      `SELECT signature_hash, sealed_at, integrity_evidence, timestamp_evidence FROM document_seals WHERE document_id = $1`,
      [documentId],
    );
    return row ?? null;
  }

  async function advancedSignatures(documentId: string) {
    const rows = await db.dataSource.query(
      `SELECT advanced_signature FROM collaborators WHERE document_id = $1 ORDER BY signing_order`,
      [documentId],
    );
    return rows.map(
      (row: { advanced_signature: any }) => row.advanced_signature,
    );
  }

  /** Simula que pasó el tiempo de espera de los reintentos programados. */
  const elapse = () =>
    db.dataSource.query(
      `UPDATE document_sealing_jobs SET next_attempt_at = now() - interval '1 second' WHERE status = 'RETRY_SCHEDULED'`,
    );

  const keyOf = (documentId: string) =>
    `signature-server:document:${documentId}:v1`;

  const pageCount = async (content: Buffer) =>
    (await PDFDocument.load(content)).getPageCount();

  describe('OCSP con el adaptador controlado', () => {
    it('SAT falla y después responde: guarda el OCSP y continúa el sellado', async () => {
      const { worker } = buildWorker();
      const { documentId, jobId } = await advancedDocument([
        { pem: TEST_CERTIFICATE_PEM_1, withOcsp: true },
        { pem: TEST_CERTIFICATE_PEM_2, withOcsp: false },
      ]);
      ocsp.script(TEST_CERTIFICATE_PEM_2, 'unavailable', 'good');

      await worker.drain();

      expect(await jobRow(jobId)).toEqual(
        expect.objectContaining({
          status: 'RETRY_SCHEDULED',
          phase: 'VERIFYING_OCSP',
          last_error_code: 'OCSP_UNAVAILABLE',
          sealing_pending_at: expect.any(Date),
        }),
      );
      expect(provider.sealRequests()).toHaveLength(0);

      await elapse();
      await worker.drain();

      expect(await jobRow(jobId)).toEqual(
        expect.objectContaining({
          status: 'COMPLETED',
          attempt_count: 2,
          sealing_pending_at: null,
        }),
      );
      const [first, second] = await advancedSignatures(documentId);
      // El primero ya traía evidencia: no se le volvió a preguntar al SAT.
      expect(ocsp.callsFor(TEST_CERTIFICATE_PEM_1)).toBe(0);
      expect(second.ocspEvidence.status).toBe('good');
      // `verifiedAt` es la consulta del reintento; `signedAt` sigue siendo el de la firma.
      expect(second.signedAt).toBe('2026-11-19T12:00:00.000Z');
      expect(
        new Date(second.ocspEvidence.verifiedAt).getTime(),
      ).toBeGreaterThan(new Date(second.signedAt).getTime());
      // Lo que viajó al proveedor es exactamente lo que quedó guardado.
      const [request] = provider.sealRequests();
      expect(request.body!.signatures).toEqual([
        expect.objectContaining({
          ocspEvidence: expect.objectContaining({
            ocspResponse: first.ocspEvidence.ocspResponse,
          }),
        }),
        expect.objectContaining({
          ocspEvidence: expect.objectContaining({
            ocspResponse: second.ocspEvidence.ocspResponse,
          }),
        }),
      ]);
      expect(provider.emissions).toBe(1);
      // Ninguna firma guarda ni necesitó llave privada o contraseña.
      expect(JSON.stringify(await advancedSignatures(documentId))).not.toMatch(
        /privateKey|password|\.key/i,
      );
      expect(Object.keys(controlledEfirma)).toEqual(['validarCadenaConfianza']);
      // Al completar, la huella del XML de auditoría queda guardada y es reproducible.
      const digests = await verificationRecordDigests(documentId);
      expect(digests.stored).toMatch(/^[0-9a-f]{64}$/);
      expect(digests.rebuilt).toBe(digests.stored);
    });

    it('un firmante sigue sin evidencia: no se emite el sello', async () => {
      const { worker } = buildWorker();
      const { documentId, jobId } = await advancedDocument([
        { pem: TEST_CERTIFICATE_PEM_1, withOcsp: false },
        { pem: TEST_CERTIFICATE_PEM_2, withOcsp: false },
      ]);
      ocsp.script(
        TEST_CERTIFICATE_PEM_2,
        'unavailable',
        'unavailable',
        'unavailable',
      );

      for (let round = 0; round < 3; round++) {
        await worker.drain();
        await elapse();
      }

      expect(provider.requests).toHaveLength(0);
      expect(await sealOf(documentId)).toBeNull();
      const [first, second] = await advancedSignatures(documentId);
      // La evidencia que sí llegó se conservó desde el primer intento.
      expect(first.ocspEvidence.status).toBe('good');
      expect(ocsp.callsFor(TEST_CERTIFICATE_PEM_1)).toBe(1);
      expect(second.ocspEvidence).toBeUndefined();
      expect(await jobRow(jobId)).toEqual(
        expect.objectContaining({
          status: 'RETRY_SCHEDULED',
          attempt_count: 3,
          last_error_code: 'OCSP_UNAVAILABLE',
        }),
      );
    });

    it('SAT reporta revocación: trabajo terminal, sin emisión', async () => {
      const { worker } = buildWorker();
      const { documentId, jobId } = await advancedDocument([
        { pem: TEST_CERTIFICATE_PEM_1, withOcsp: false },
      ]);
      ocsp.script(TEST_CERTIFICATE_PEM_1, 'revoked');

      await worker.drain();
      await elapse();
      await worker.drain();

      expect(await jobRow(jobId)).toEqual(
        expect.objectContaining({
          status: 'DEAD',
          attempt_count: 1,
          last_error_code: 'OCSP_CERTIFICATE_REVOKED',
          last_error_message: expect.stringContaining('2026-10-01'),
          lease_token: null,
        }),
      );
      expect(provider.requests).toHaveLength(0);
      expect(await sealOf(documentId)).toBeNull();
      expect(
        (await advancedSignatures(documentId))[0].ocspEvidence,
      ).toBeUndefined();
    });
  });

  describe('Seal Service con el servidor de prueba', () => {
    it('falla y después se recupera: se completa con la misma clave idempotente', async () => {
      const { worker } = buildWorker();
      const { documentId, jobId } = await advancedDocument([
        { pem: TEST_CERTIFICATE_PEM_1, withOcsp: true },
      ]);
      provider.fail('http500');

      await worker.drain();
      expect(await jobRow(jobId)).toEqual(
        expect.objectContaining({
          status: 'RETRY_SCHEDULED',
          phase: 'GENERATING_SEAL',
          last_error_code: 'SEAL_PROVIDER_REJECTED',
          last_upstream_status: 500,
        }),
      );

      await elapse();
      await worker.drain();

      expect((await jobRow(jobId)).status).toBe('COMPLETED');
      const posts = provider.sealRequests();
      expect(posts.map((request) => request.idempotencyKey)).toEqual([
        keyOf(documentId),
        keyOf(documentId),
      ]);
      expect(posts[1].body).toEqual(posts[0].body);
      // El reintento consultó la operación antes de reenviar.
      expect(provider.requests.map((r) => r.method)).toEqual([
        'POST',
        'GET',
        'POST',
      ]);
      expect(provider.emissions).toBe(1);
    });

    it('un 429 respeta el Retry-After del proveedor', async () => {
      const { worker } = buildWorker();
      const { jobId } = await advancedDocument([
        { pem: TEST_CERTIFICATE_PEM_1, withOcsp: true },
      ]);
      provider.fail('http429');

      await worker.drain();

      const row = await jobRow(jobId);
      expect(row.last_upstream_status).toBe(429);
      // Retry-After: 120 s, por encima del primer escalón (1 min ±20 %).
      expect(new Date(row.next_attempt_at).getTime()).toBeGreaterThanOrEqual(
        Date.now() + 115_000,
      );
    });

    it('el proveedor emite y se pierde la respuesta: se recupera la misma evidencia', async () => {
      const { worker } = buildWorker();
      const { documentId, jobId } = await advancedDocument([
        { pem: TEST_CERTIFICATE_PEM_1, withOcsp: true },
      ]);
      provider.fail('emitAndDropResponse');

      await worker.drain();
      expect(await jobRow(jobId)).toEqual(
        expect.objectContaining({
          status: 'RETRY_SCHEDULED',
          last_error_code: 'SEAL_PROVIDER_UNAVAILABLE',
        }),
      );
      expect(await sealOf(documentId)).toBeNull();
      const emitted = provider.evidenceFor(keyOf(documentId))!;

      await elapse();
      await worker.drain();

      const seal = await sealOf(documentId);
      expect(seal.integrity_evidence.evidenceId).toBe(emitted.nom151.uuid);
      expect(seal.timestamp_evidence.evidenceId).toBe(emitted.timeStamp.uuid);
      expect(seal.signature_hash).toBe(emitted.hashHex);
      expect(provider.emissions).toBe(1);
      expect((await jobRow(jobId)).status).toBe('COMPLETED');
    });

    it('falla la BD después de emitir: se recupera y persiste el resultado existente', async () => {
      const { worker } = buildWorker();
      const { documentId, jobId } = await advancedDocument([
        { pem: TEST_CERTIFICATE_PEM_1, withOcsp: true },
      ]);
      sealSaveFailures = 1;

      await worker.drain();
      expect(await jobRow(jobId)).toEqual(
        expect.objectContaining({
          status: 'RETRY_SCHEDULED',
          phase: 'GENERATING_SEAL',
          last_error_code: 'SEAL_PERSISTENCE_FAILED',
        }),
      );
      expect(await sealOf(documentId)).toBeNull();

      await elapse();
      await worker.drain();

      expect((await sealOf(documentId)).integrity_evidence.evidenceId).toBe(
        provider.evidenceFor(keyOf(documentId))!.nom151.uuid,
      );
      expect(provider.emissions).toBe(1);
      expect((await jobRow(jobId)).status).toBe('COMPLETED');
    });

    it('resultado externo incierto: queda detenido para conciliación', async () => {
      const { worker } = buildWorker();
      const { documentId, jobId } = await advancedDocument([
        { pem: TEST_CERTIFICATE_PEM_1, withOcsp: true },
      ]);
      provider.fail('reconciliation');

      await worker.drain();
      await elapse();
      await worker.drain();

      expect(await jobRow(jobId)).toEqual(
        expect.objectContaining({
          status: 'RECONCILIATION_REQUIRED',
          attempt_count: 1,
          last_error_code: 'SEAL_RECONCILIATION_REQUIRED',
          last_error_message: expect.stringContaining('PSC_UNCERTAIN_RESULT'),
          sealing_pending_at: expect.any(Date),
        }),
      );
      expect(provider.sealRequests()).toHaveLength(1);
      expect(await sealOf(documentId)).toBeNull();
    });

    it('se agotan los intentos: DEAD con diagnóstico y no se vuelve a seleccionar', async () => {
      const { worker } = buildWorker(db.dataSource, { maxAttempts: 8 });
      const { jobId } = await advancedDocument([
        { pem: TEST_CERTIFICATE_PEM_1, withOcsp: true },
      ]);
      provider.fail(...Array<'http500'>(10).fill('http500'));

      for (let attempt = 0; attempt < 9; attempt++) {
        await worker.drain();
        await elapse();
      }

      expect(await jobRow(jobId)).toEqual(
        expect.objectContaining({
          status: 'DEAD',
          attempt_count: 8,
          phase: 'GENERATING_SEAL',
          last_error_code: 'SEAL_PROVIDER_REJECTED',
          last_upstream_status: 500,
          last_error_message: expect.stringContaining('Se agotaron'),
          lease_token: null,
          request_object_key: expect.any(String),
        }),
      );
      expect(provider.sealRequests()).toHaveLength(8);
      expect(provider.emissions).toBe(0);
    });
  });

  describe('PDF final y evidencia', () => {
    it('falla el PDF después de guardar el sello: rehace el anexo sin volver a emitir', async () => {
      const { worker } = buildWorker();
      const { documentId, jobId, objectKey, pdf } = await advancedDocument([
        { pem: TEST_CERTIFICATE_PEM_1, withOcsp: true },
      ]);
      minio.failNext('putPdf');

      await worker.drain();
      expect(await jobRow(jobId)).toEqual(
        expect.objectContaining({
          status: 'RETRY_SCHEDULED',
          phase: 'UPDATING_EVIDENCE_PDF',
          last_error_code: 'EVIDENCE_PDF_UPDATE_FAILED',
          sealing_pending_at: expect.any(Date),
        }),
      );
      expect(await sealOf(documentId)).not.toBeNull();

      await elapse();
      await worker.drain();

      expect((await jobRow(jobId)).status).toBe('COMPLETED');
      expect(provider.sealRequests()).toHaveLength(1);
      expect(provider.emissions).toBe(1);

      // La copia final: PDF firmado + hoja, con la constancia persistida.
      const finalPdf = minio.read(
        BUCKET_TYPES_ENUM.FINALIZED_DOCUMENTS,
        objectKey,
      )!;
      const seal = await sealOf(documentId);
      const [, sheetSigners] = summarySpy.mock.calls.at(-1)!;
      const [sheetInfo] = summarySpy.mock.calls.at(-1)!;
      expect(sheetInfo.conservationRecord).toEqual(
        expect.objectContaining({ issuedAt: seal.sealed_at }),
      );
      expect(sheetSigners).toHaveLength(1);
      const sheetPages = (await pageCount(finalPdf)) - (await pageCount(pdf));
      expect(sheetPages).toBeGreaterThan(0);

      // El PDF firmado y su hash no cambiaron.
      expect(
        minio.read(BUCKET_TYPES_ENUM.SIGNED_DOCUMENTS, objectKey)!.equals(pdf),
      ).toBe(true);
      expect((await jobRow(jobId)).signed_hash).toBe(sha256(pdf));
    });

    it('rehacer el anexo no duplica páginas y la vista pública muestra la evidencia', async () => {
      const { worker } = buildWorker();
      const { documentId, objectKey, pdf } = await advancedDocument([
        { pem: TEST_CERTIFICATE_PEM_1, withOcsp: true },
      ]);
      await worker.drain();
      const firstFinal = minio.read(
        BUCKET_TYPES_ENUM.FINALIZED_DOCUMENTS,
        objectKey,
      )!;

      // Repetir la fase del PDF (p. ej. una caída antes del commit) parte del mismo PDF firmado.
      const seal = await db.dataSource
        .getRepository(SealEntity)
        .findOneByOrFail({ documentId });
      const refresher = new RefreshSealedDocumentEvidenceService(
        documentServiceFor(db.dataSource) as never,
        db.dataSource.getRepository(CollaboratorEntity),
        minio as never,
        new HashService(),
        { useEvidenceRefresher: () => undefined } as never,
        digestRecorderFor(
          db.dataSource,
          new SealDocumentUseCase(
            {} as never,
            db.dataSource.getRepository(SealEntity),
          ),
        ),
      );
      await refresher.refresh(documentId, seal);
      await refresher.refresh(documentId, seal);
      const secondFinal = minio.read(
        BUCKET_TYPES_ENUM.FINALIZED_DOCUMENTS,
        objectKey,
      )!;

      expect(await pageCount(secondFinal)).toBe(await pageCount(firstFinal));
      expect(await pageCount(secondFinal)).toBeGreaterThan(
        await pageCount(pdf),
      );
      expect(
        minio.read(BUCKET_TYPES_ENUM.SIGNED_DOCUMENTS, objectKey)!.equals(pdf),
      ).toBe(true);

      const view = await new GetPublicDocumentUseCase(
        db.dataSource.getRepository(CollaboratorEntity),
        db.dataSource.getRepository(DocumentSealingJobEntity),
        minio as never,
        {
          findOne: async () => ({ email: 'creadora@correo.example' }),
        } as never,
        new SealDocumentUseCase(
          {} as never,
          db.dataSource.getRepository(SealEntity),
        ),
        {
          findOne: (id: string) =>
            db.dataSource.getRepository(DocumentEntity).findOneByOrFail({ id }),
          toCompletedPublicSigner: async () => ({}),
        } as never,
      ).execute(documentId);

      expect(view.data).toEqual(
        expect.objectContaining({
          sealingStatus: PUBLIC_SEALING_STATUS_ENUM.COMPLETED,
          sealingPending: false,
          hash: sha256(pdf),
          secureUrl: expect.stringContaining(
            `finalized_documents/${objectKey}`,
          ),
          downloads: { nom151: true, timestamp: true, canonical: true },
          conservationRecord: expect.objectContaining({
            issuedAt: new Date(seal.sealedAt!).toISOString(),
          }),
        }),
      );
      // Abrir la vista no consultó a nadie.
      expect(provider.requests).toHaveLength(1);
    });
  });

  describe('recuperación del proceso', () => {
    it('reinicio después de emitir y antes de registrar: se recupera el lease vencido sin reemitir', async () => {
      const { processor, config } = buildWorker();
      const { documentId, jobId } = await advancedDocument([
        { pem: TEST_CERTIFICATE_PEM_1, withOcsp: true },
      ]);
      // La instancia A reclama, emite y muere antes de guardar la constancia y de registrar nada.
      const [claimed] = await new ClaimDueSealingJobsUseCase(
        db.dataSource,
        config,
      ).execute(1);
      sealSaveFailures = 1;
      await expect(
        processor.execute(claimed.id, claimed.leaseToken),
      ).rejects.toBeInstanceOf(DocumentSealingJobFailedException);
      expect((await jobRow(jobId)).status).toBe('PROCESSING');
      await db.dataSource.query(
        `UPDATE document_sealing_jobs SET lease_expires_at = now() - interval '1 second' WHERE id = $1`,
        [jobId],
      );

      // La instancia B recupera el trabajo.
      await buildWorker().worker.drain();

      expect(await jobRow(jobId)).toEqual(
        expect.objectContaining({ status: 'COMPLETED', attempt_count: 2 }),
      );
      expect(provider.requests.map((r) => r.method)).toEqual([
        'POST',
        'GET',
        'POST',
      ]);
      expect(provider.emissions).toBe(1);
      expect((await sealOf(documentId)).integrity_evidence.evidenceId).toBe(
        provider.evidenceFor(keyOf(documentId))!.nom151.uuid,
      );
    });

    it('dos workers procesan candidatos: cada trabajo se ejecuta una sola vez', async () => {
      const documents = [];
      for (let i = 0; i < 6; i++) {
        documents.push(
          await advancedDocument([
            { pem: TEST_CERTIFICATE_PEM_1, withOcsp: true },
          ]),
        );
      }
      const first = buildWorker(await db.connect(), { concurrency: 2 });
      const second = buildWorker(await db.connect(), { concurrency: 2 });

      const [a, b] = await Promise.all([
        first.worker.drain(),
        second.worker.drain(),
      ]);

      expect(a.claimed + b.claimed).toBe(6);
      expect(provider.emissions).toBe(6);
      const keys = provider.sealRequests().map((r) => r.idempotencyKey);
      expect(new Set(keys).size).toBe(6);
      for (const { jobId } of documents) {
        expect(await jobRow(jobId)).toEqual(
          expect.objectContaining({ status: 'COMPLETED', attempt_count: 1 }),
        );
      }
    });
  });

  describe('firma simple', () => {
    const PNG = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from('rubrica'),
    ]);
    const JPEG = Buffer.concat([
      Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
      Buffer.from('ine'),
    ]);

    it('reintentada: conserva el payload original aunque cambie el perfil', async () => {
      const { worker } = buildWorker();
      const pdf = await signedPdf();
      const objectKey = `${randomUUID()}.pdf`;
      minio.write(BUCKET_TYPES_ENUM.SIGNED_DOCUMENTS, objectKey, pdf);
      minio.write(BUCKET_TYPES_ENUM.CREATED_DOCUMENTS, objectKey, ORIGINAL_PDF);
      minio.write(BUCKET_TYPES_ENUM.SIGNATURE_IMAGES, 'snap/rubrica.png', PNG);
      minio.write(BUCKET_TYPES_ENUM.IDENTITY_DOCUMENTS, 'ine/front', JPEG);
      minio.write(BUCKET_TYPES_ENUM.IDENTITY_DOCUMENTS, 'ine/back', JPEG);

      const personalId = await db.insertReturningId(
        `INSERT INTO personal_information (name, last_name, curp, front_image_key, back_image_key) VALUES ('Luis', 'Martínez', 'MAML900101HDFRRS09', 'ine/front', 'ine/back')`,
        [],
      );
      const userId = await db.insertReturningId(
        `INSERT INTO users (first_name, last_name, email, roles, lifecycle_status, personal_information_id) VALUES ('Luis', 'Martínez', $1, 'user', 'PROVISIONED', $2)`,
        [`luis-${randomUUID()}@correo.example`, personalId],
      );
      const accountId = await db.insertReturningId(
        `INSERT INTO accounts (user_id, account_type, email) VALUES ($1, 'PERSONAL', 'luis@correo.example')`,
        [userId],
      );
      const documentId = await db.insertDocument({
        objectKey,
        signedHash: sha256(pdf),
        signatureType: 'SIMPLE',
      });
      const collaboratorId = await db.insertReturningId(
        `INSERT INTO collaborators (document_id, ip_address, colaborator_type, signature_type, status, signing_order, resolved_at, account_id, signature_snapshot_object_key)
         VALUES ($1, '127.0.0.1', 'SIGNER', 'SIMPLE', 'SIGNED', 1, '2026-11-19T17:00:00Z', $2, 'snap/rubrica.png')`,
        [documentId, accountId],
      );
      await db.dataSource.query(
        `INSERT INTO verification_codes (code, event, is_used, used_at, ip_address, expired_at, signer_id, document_id)
         VALUES ('482913', 'sign_document', true, '2026-11-19T16:59:00Z', '127.0.0.1', now() + interval '1 day', $1, $2)`,
        [collaboratorId, documentId],
      );

      // Al cerrar: payload congelado y trabajo registrado.
      const request = await snapshotsFor(
        db.dataSource,
      ).freezeSimpleSignatureRequest({
        documentId,
        originalHash: 'hash-original',
        signedHash: sha256(pdf),
      });
      const { job } = await db.dataSource.transaction((manager) =>
        registerJob.execute(
          { documentId, sealType: SEALING_TYPE_ENUM.SIMPLE, request },
          manager,
        ),
      );

      provider.fail('http500');
      await worker.drain();

      // Entre intentos, el firmante corrige su perfil.
      await db.dataSource.query(
        `UPDATE personal_information SET curp = 'OTRA800101HDFRRN01', name = 'Otro' WHERE id = $1`,
        [personalId],
      );
      await elapse();
      await worker.drain();

      expect((await jobRow(job.id)).status).toBe('COMPLETED');
      const [first, second] = provider.sealRequests();
      expect(first.path).toBe('/seal/simple-signature');
      expect(second.body).toEqual(first.body);
      expect(second.body!.signatures).toEqual([
        expect.objectContaining({
          curp: 'MAML900101HDFRRS09',
          name: 'Luis',
          verificationData: expect.objectContaining({ code: '482913' }),
          signatureMedia: {
            signatureImage: PNG.toString('base64'),
            identityDocumentFrontImage: JPEG.toString('base64'),
            identityDocumentBackImage: JPEG.toString('base64'),
          },
        }),
      ]);
      expect(provider.emissions).toBe(1);
    });
  });
});
