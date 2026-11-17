import { ConflictException, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { ProcessIndexerNotificationUseCase } from './process-indexer-notification.use-case';
import { DocumentIndexingJobEntity } from '../entities/document-indexing-job.entity';
import { DOCUMENT_INDEXING_STATUS_ENUM } from '../enum/document-indexing-status.enum';

const DOCUMENT_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const JOB_ID = '9f2c4e1a7b3d5f60819a2b3c4d5e6f70';
const EXTERNAL_DOCUMENT_ID = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
const REQUEST_METADATA = { originType: 'digital_native' };

function jobWith(
  overrides: Partial<DocumentIndexingJobEntity> = {},
): DocumentIndexingJobEntity {
  return {
    id: 'job-1',
    documentId: DOCUMENT_ID,
    status: DOCUMENT_INDEXING_STATUS_ENUM.PENDING,
    externalJobId: null,
    externalDocumentId: null,
    receivedAt: null,
    completedAt: null,
    error: null,
    metadata: REQUEST_METADATA,
    ...overrides,
  } as DocumentIndexingJobEntity;
}

const NOTIFICATION = {
  jobId: JOB_ID,
  externalDocumentId: EXTERNAL_DOCUMENT_ID,
  clientDocumentId: DOCUMENT_ID,
};

describe('ProcessIndexerNotificationUseCase', () => {
  let repository: { findOne: jest.Mock; save: jest.Mock };
  let useCase: ProcessIndexerNotificationUseCase;

  beforeEach(() => {
    repository = {
      findOne: jest.fn(),
      save: jest.fn(async (job: DocumentIndexingJobEntity) => job),
    };
    const manager = { getRepository: jest.fn(() => repository) };

    useCase = new ProcessIndexerNotificationUseCase({
      transaction: jest.fn(async (work) => work(manager)),
    } as unknown as DataSource);
  });

  it('localiza el job por clientDocumentId, bloqueado y en su versión más reciente', async () => {
    repository.findOne.mockResolvedValue(jobWith());

    await useCase.execute({ ...NOTIFICATION, state: 'received' });

    expect(repository.findOne).toHaveBeenCalledWith({
      where: { documentId: DOCUMENT_ID },
      order: { createdAt: 'DESC' },
      lock: { mode: 'pessimistic_write' },
    });
  });

  it('received: pasa a RECEIVED y guarda los identificadores externos', async () => {
    const job = jobWith();
    repository.findOne.mockResolvedValue(job);

    await expect(
      useCase.execute({ ...NOTIFICATION, state: 'received', duplicate: false }),
    ).resolves.toBe(true);

    expect(repository.save).toHaveBeenCalledWith(job);
    expect(job.status).toBe(DOCUMENT_INDEXING_STATUS_ENUM.RECEIVED);
    expect(job.externalJobId).toBe(JOB_ID);
    expect(job.externalDocumentId).toBe(EXTERNAL_DOCUMENT_ID);
    expect(job.receivedAt).toBeInstanceOf(Date);
    expect(job.completedAt).toBeNull();
  });

  it('conserva en metadata la solicitud original y agrega la respuesta', async () => {
    const job = jobWith();
    repository.findOne.mockResolvedValue(job);

    await useCase.execute({
      ...NOTIFICATION,
      state: 'received',
      duplicate: true,
    });

    expect(job.metadata).toEqual({
      ...REQUEST_METADATA,
      response: {
        providerState: 'received',
        duplicate: true,
        receivedAt: job.receivedAt.toISOString(),
      },
    });
  });

  it('duplicate: true se procesa normalmente, sin error ni job nuevo', async () => {
    const job = jobWith();
    repository.findOne.mockResolvedValue(job);

    await useCase.execute({
      ...NOTIFICATION,
      state: 'received',
      duplicate: true,
    });

    expect(repository.save).toHaveBeenCalledTimes(1);
    expect(repository.save.mock.calls[0][0].id).toBe('job-1');
    expect(job.status).toBe(DOCUMENT_INDEXING_STATUS_ENUM.RECEIVED);
    expect(job.error).toBeNull();
  });

  it('indexed: pasa a INDEXED, cierra el job y limpia el error', async () => {
    const receivedAt = new Date('2026-10-31T12:00:00.000Z');
    const job = jobWith({
      status: DOCUMENT_INDEXING_STATUS_ENUM.RECEIVED,
      externalJobId: JOB_ID,
      externalDocumentId: EXTERNAL_DOCUMENT_ID,
      receivedAt,
      error: 'previo',
      metadata: {
        ...REQUEST_METADATA,
        response: { providerState: 'received', duplicate: true },
      },
    });
    repository.findOne.mockResolvedValue(job);

    await expect(
      useCase.execute({ ...NOTIFICATION, state: 'indexed' }),
    ).resolves.toBe(true);

    expect(job.status).toBe(DOCUMENT_INDEXING_STATUS_ENUM.INDEXED);
    expect(job.completedAt).toBeInstanceOf(Date);
    expect(job.error).toBeNull();
    expect(job.receivedAt).toBe(receivedAt);
    // Sin `duplicate` en esta entrega se conserva lo que dijo la anterior.
    expect(job.metadata.response).toEqual({
      providerState: 'indexed',
      duplicate: true,
      receivedAt: job.completedAt.toISOString(),
    });
  });

  it('failed: pasa a FAILED, cierra el job y guarda el detalle', async () => {
    const job = jobWith({
      status: DOCUMENT_INDEXING_STATUS_ENUM.RECEIVED,
      externalJobId: JOB_ID,
    });
    repository.findOne.mockResolvedValue(job);

    await useCase.execute({
      ...NOTIFICATION,
      state: 'failed',
      error: 'PDF ilegible',
    });

    expect(job.status).toBe(DOCUMENT_INDEXING_STATUS_ENUM.FAILED);
    expect(job.completedAt).toBeInstanceOf(Date);
    expect(job.error).toBe('PDF ilegible');
  });

  it.each([[undefined], [''], [{ code: 500 }]])(
    'failed: sin un detalle legible (%j) guarda un mensaje genérico',
    async (error) => {
      const job = jobWith();
      repository.findOne.mockResolvedValue(job);

      await useCase.execute({ ...NOTIFICATION, state: 'failed', error });

      expect(job.error).toBe('El indexador reportó un fallo sin detalle');
    },
  );

  it('un resultado final sin received previo identifica igual el job', async () => {
    const job = jobWith();
    repository.findOne.mockResolvedValue(job);

    await useCase.execute({ ...NOTIFICATION, state: 'indexed' });

    expect(job.status).toBe(DOCUMENT_INDEXING_STATUS_ENUM.INDEXED);
    expect(job.externalJobId).toBe(JOB_ID);
    expect(job.externalDocumentId).toBe(EXTERNAL_DOCUMENT_ID);
    expect(job.receivedAt).toBeNull();
  });

  it.each([
    [DOCUMENT_INDEXING_STATUS_ENUM.RECEIVED, 'received'],
    [DOCUMENT_INDEXING_STATUS_ENUM.INDEXED, 'received'],
    [DOCUMENT_INDEXING_STATUS_ENUM.INDEXED, 'indexed'],
    [DOCUMENT_INDEXING_STATUS_ENUM.INDEXED, 'failed'],
    [DOCUMENT_INDEXING_STATUS_ENUM.FAILED, 'received'],
    [DOCUMENT_INDEXING_STATUS_ENUM.FAILED, 'indexed'],
    [DOCUMENT_INDEXING_STATUS_ENUM.FAILED, 'failed'],
  ] as const)(
    'un job en %s ignora una notificación %s sin modificarse',
    async (status, state) => {
      const job = jobWith({ status, externalJobId: JOB_ID });
      const before = { ...job };
      repository.findOne.mockResolvedValue(job);

      await expect(useCase.execute({ ...NOTIFICATION, state })).resolves.toBe(
        false,
      );

      expect(repository.save).not.toHaveBeenCalled();
      expect(job).toEqual(before);
    },
  );

  it('sin job para el documento lanza NotFoundException', async () => {
    repository.findOne.mockResolvedValue(null);

    await expect(
      useCase.execute({ ...NOTIFICATION, state: 'received' }),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(repository.save).not.toHaveBeenCalled();
  });

  it('un jobId distinto al del job lanza ConflictException sin modificarlo', async () => {
    repository.findOne.mockResolvedValue(
      jobWith({
        status: DOCUMENT_INDEXING_STATUS_ENUM.RECEIVED,
        externalJobId: 'otro-job',
      }),
    );

    await expect(
      useCase.execute({ ...NOTIFICATION, state: 'indexed' }),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(repository.save).not.toHaveBeenCalled();
  });
});
