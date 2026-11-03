import { createHmac } from 'crypto';
import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm';
import * as request from 'supertest';

import { applyGlobalApiPrefix } from './../src/common/constants/api-prefix.constants';
import { ProcessIndexerNotificationUseCase } from './../src/document/applications/process-indexer-notification.use-case';
import { DocumentIndexingJobEntity } from './../src/document/entities/document-indexing-job.entity';
import { DOCUMENT_INDEXING_STATUS_ENUM } from './../src/document/enum/document-indexing-status.enum';
import { IndexerWebhookController } from './../src/webhooks/indexer-webhook.controller';
import { ReceiveIndexerWebhookUseCase } from './../src/webhooks/applications/receive-indexer-webhook.use-case';
import { RegisterWebhookEventUseCase } from './../src/webhooks/applications/register-webhook-event.use-case';
import { IndexerWebhookSignatureVerifierService } from './../src/webhooks/indexer/indexer-webhook-signature-verifier.service';
import { WebhookEventEntity } from './../src/webhooks/entities/webhook-event.entity';
import { WEBHOOK_PROCESSING_STATUS_ENUM } from './../src/webhooks/enums/webhook-processing-status.enum';
import { WEBHOOK_PROVIDER_ENUM } from './../src/webhooks/enums/webhook-provider.enum';
import {
  createDataSourceStub,
  createInMemoryRepository,
  InMemoryRepository,
} from './billing-e2e-fixtures';

/** Secreto de esta prueba: la firma se genera acá mismo y la verificación es la real. */
const WEBHOOK_SECRET = 'secreto_de_pruebas_e2e';
const ENDPOINT = '/api/v1/webhooks/indexer';

const DOCUMENT_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const PAYLOAD = {
  jobId: '9f2c4e1a7b3d5f60819a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f70',
  documentId: '3fa85f64-5717-4562-b3fc-2c963f66afa6',
  state: 'received',
  duplicate: true,
  clientDocumentId: DOCUMENT_ID,
};

describe('POST /api/v1/webhooks/indexer (e2e)', () => {
  let app: INestApplication;
  let jobs: InMemoryRepository<DocumentIndexingJobEntity>;
  let events: InMemoryRepository<WebhookEventEntity>;

  /** Envía `body` tal cual, firmado salvo que se indique otra firma. */
  function deliver(body: unknown, signature?: string) {
    const rawBody = typeof body === 'string' ? body : JSON.stringify(body);

    return request(app.getHttpServer())
      .post(ENDPOINT)
      .set('content-type', 'application/json')
      .set(
        'x-signature',
        signature ??
          createHmac('sha256', WEBHOOK_SECRET).update(rawBody).digest('hex'),
      )
      .set('x-timestamp', String(Math.floor(Date.now() / 1000)))
      .send(rawBody);
  }

  beforeEach(async () => {
    jobs = createInMemoryRepository<DocumentIndexingJobEntity>([
      {
        id: 'job-1',
        documentId: DOCUMENT_ID,
        status: DOCUMENT_INDEXING_STATUS_ENUM.PENDING,
        externalJobId: null,
        externalDocumentId: null,
        receivedAt: null,
        completedAt: null,
        error: null,
        metadata: { originType: 'digital_native' },
        createdAt: new Date('2026-10-31T12:00:00.000Z'),
      } as unknown as DocumentIndexingJobEntity,
    ]);
    events = createInMemoryRepository<WebhookEventEntity>();

    const moduleFixture: TestingModule = await Test.createTestingModule({
      controllers: [IndexerWebhookController],
      providers: [
        ReceiveIndexerWebhookUseCase,
        RegisterWebhookEventUseCase,
        IndexerWebhookSignatureVerifierService,
        ProcessIndexerNotificationUseCase,
        {
          provide: ConfigService,
          useValue: {
            get: (key: string) =>
              key === 'INDEXER_WEBHOOK_SECRET' ? WEBHOOK_SECRET : undefined,
          },
        },
        {
          provide: getRepositoryToken(WebhookEventEntity),
          useValue: events,
        },
        {
          provide: getDataSourceToken(),
          useValue: createDataSourceStub(
            new Map<unknown, InMemoryRepository<never>>([
              [
                DocumentIndexingJobEntity,
                jobs as unknown as InMemoryRepository<never>,
              ],
            ]),
          ).dataSource,
        },
      ],
    }).compile();

    app = moduleFixture.createNestApplication({ rawBody: true });
    applyGlobalApiPrefix(app);
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it('recorre PENDING → RECEIVED → INDEXED sobre el mismo job', async () => {
    await deliver(PAYLOAD).expect(200, { received: true, duplicate: false });

    expect(jobs.rows[0]).toMatchObject({
      status: DOCUMENT_INDEXING_STATUS_ENUM.RECEIVED,
      externalJobId: PAYLOAD.jobId,
      externalDocumentId: PAYLOAD.documentId,
      metadata: {
        originType: 'digital_native',
        response: { providerState: 'received', duplicate: true },
      },
    });
    expect(jobs.rows[0].receivedAt).toBeInstanceOf(Date);

    await deliver({ ...PAYLOAD, state: 'indexed' }).expect(200, {
      received: true,
      duplicate: false,
    });

    expect(jobs.rows).toHaveLength(1);
    expect(jobs.rows[0].status).toBe(DOCUMENT_INDEXING_STATUS_ENUM.INDEXED);
    expect(jobs.rows[0].completedAt).toBeInstanceOf(Date);
    expect(events.rows).toHaveLength(2);
    expect(events.rows[0]).toMatchObject({
      provider: WEBHOOK_PROVIDER_ENUM.INDEXER,
      processingStatus: WEBHOOK_PROCESSING_STATUS_ENUM.PROCESSED,
    });
  });

  it('recorre PENDING → RECEIVED → FAILED y guarda el detalle', async () => {
    await deliver(PAYLOAD).expect(200);
    await deliver({
      ...PAYLOAD,
      state: 'failed',
      error: 'PDF ilegible',
    }).expect(200);

    expect(jobs.rows[0]).toMatchObject({
      status: DOCUMENT_INDEXING_STATUS_ENUM.FAILED,
      error: 'PDF ilegible',
    });
  });

  it('una entrega duplicada responde 200 sin volver a aplicarse', async () => {
    await deliver(PAYLOAD).expect(200);
    const receivedAt = jobs.rows[0].receivedAt;

    await deliver(PAYLOAD).expect(200, { received: true, duplicate: true });

    expect(jobs.rows[0].receivedAt).toBe(receivedAt);
    expect(events.rows).toHaveLength(1);
  });

  it('un received tardío no degrada un job INDEXED', async () => {
    await deliver({ ...PAYLOAD, state: 'indexed' }).expect(200);

    await deliver(PAYLOAD).expect(200, { received: true, duplicate: true });

    expect(jobs.rows[0].status).toBe(DOCUMENT_INDEXING_STATUS_ENUM.INDEXED);
    expect(jobs.rows[0].receivedAt).toBeNull();
  });

  it('una firma inválida responde 401, audita y no toca el job', async () => {
    await deliver(PAYLOAD, 'firma-falsa').expect(401);

    expect(jobs.rows[0].status).toBe(DOCUMENT_INDEXING_STATUS_ENUM.PENDING);
    expect(events.rows[0]).toMatchObject({
      provider: WEBHOOK_PROVIDER_ENUM.INDEXER,
      signatureValid: false,
      payload: null,
    });
  });

  it.each([
    ['un esquema incumplido', { ...PAYLOAD, state: 'processing' }],
    ['un cuerpo que no es objeto', '[]'],
  ])('%s responde 400 y no toca el job', async (_, body) => {
    await deliver(body).expect(400);

    expect(jobs.rows[0].status).toBe(DOCUMENT_INDEXING_STATUS_ENUM.PENDING);
    expect(events.rows[0]).toMatchObject({
      signatureValid: true,
      eventType: 'invalid_payload',
    });
  });

  it('un job inexistente responde 404 y deja el incidente en la bitácora', async () => {
    await deliver({
      ...PAYLOAD,
      clientDocumentId: '1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed',
    }).expect(404);

    expect(events.rows[0]).toMatchObject({
      provider: WEBHOOK_PROVIDER_ENUM.INDEXER,
      processingStatus: WEBHOOK_PROCESSING_STATUS_ENUM.FAILED,
      error: expect.stringContaining('NotFoundException'),
    });
  });
});
