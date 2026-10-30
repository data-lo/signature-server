import { DocumentEventsProducer } from 'src/kafka/document-events.producer';

import { DocumentIndexingJobEntity } from '../entities/document-indexing-job.entity';
import { DOCUMENT_INDEXING_STATUS_ENUM } from '../enum/document-indexing-status.enum';

import {
  DocumentIndexRequestService,
  IndexableDocument,
} from './document-index-request.service';

/**
 * Historia "Publicar evento document.index al crear un documento indexable": el contrato del
 * indexador se arma aquí, así que es aquí donde se afirma campo por campo.
 */
describe('DocumentIndexRequestService', () => {
  const ORIGINAL_ENV = { ...process.env };
  let jobRepository: { create: jest.Mock; save: jest.Mock };
  /** `EntityManager` de la transacción, reducido al repositorio de jobs. */
  let manager: { getRepository: jest.Mock };

  let documentEventsProducer: { enqueueIndexRequested: jest.Mock };
  let service: DocumentIndexRequestService;

  const organizationDocument: IndexableDocument = {
    id: 'doc-1',
    objectKey: 'a1b2c3.pdf',
    organizationId: 'org-1',
    createdAt: new Date('2026-10-30T12:00:00.000Z'),
    signedAt: null as unknown as Date,
    isIndexable: true,
  };

  const personalDocument: IndexableDocument = {
    ...organizationDocument,
    id: 'doc-2',
    organizationId: null,
  };

  beforeEach(() => {
    process.env.DOCUMENT_INDEX_ORIGIN_TYPE = 'digital_native';
    process.env.MINIO_CREATED_DOCUMENTS_BUCKET = 'created-documents';
    documentEventsProducer = {
      enqueueIndexRequested: jest.fn().mockResolvedValue({ id: 'event-1' }),
    };
    jobRepository = {
      create: jest.fn((data: object) => ({ ...data })),
      save: jest.fn(async (job: object) => ({ id: 'job-1', ...job })),
    };
    manager = {
      getRepository: jest.fn((entity: unknown) => {
        if (entity === DocumentIndexingJobEntity) return jobRepository;
        throw new Error('repositorio no mockeado');
      }),
    };
    service = new DocumentIndexRequestService(
      documentEventsProducer as unknown as DocumentEventsProducer,
    );
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  describe('payload', () => {
    /**
     * `toStrictEqual` y no `objectContaining`: el contrato es exacto, y un campo de más —p. ej. el
     * `eventId` del sobre— también lo rompe.
     */
    it('documento organizacional: cumple exactamente el contrato', () => {
      expect(service.buildPayload(organizationDocument, 'Acme')).toStrictEqual({
        organization: 'Acme',
        originType: 'digital_native',
        originReference: 'created-documents/a1b2c3.pdf',
        clientDocumentId: 'doc-1',
        metadata: {
          organizationId: 'org-1',
          createdAt: '2026-10-30T12:00:00.000Z',
          signedAt: null,
        },
      });
    });

    it('documento personal: organización e id de organización en null', () => {
      expect(service.buildPayload(personalDocument, null)).toStrictEqual({
        organization: null,
        originType: 'digital_native',
        originReference: 'created-documents/a1b2c3.pdf',
        clientDocumentId: 'doc-2',
        metadata: {
          organizationId: null,
          createdAt: '2026-10-30T12:00:00.000Z',
          signedAt: null,
        },
      });
    });

    it('un documento personal nunca publica un nombre de organización', () => {
      expect(
        service.buildPayload(personalDocument, 'Acme').organization,
      ).toBeNull();
    });

    it('originReference es bucket + objectKey, no una URL', () => {
      const { originReference } = service.buildPayload(
        organizationDocument,
        'Acme',
      );

      expect(originReference).toBe('created-documents/a1b2c3.pdf');
      expect(originReference).not.toMatch(/^https?:|X-Amz-/);
    });

    it('signedAt usa la fecha real del documento cuando existe', () => {
      const payload = service.buildPayload(
        {
          ...organizationDocument,
          signedAt: new Date('2026-10-31T08:30:00.000Z'),
        },
        'Acme',
      );

      expect(payload.metadata.signedAt).toBe('2026-10-31T08:30:00.000Z');
    });

    it('originType sale de DOCUMENT_INDEX_ORIGIN_TYPE', () => {
      process.env.DOCUMENT_INDEX_ORIGIN_TYPE = 'scanned';
      const scanned = new DocumentIndexRequestService(
        documentEventsProducer as unknown as DocumentEventsProducer,
      );

      expect(
        scanned.buildPayload(organizationDocument, 'Acme').originType,
      ).toBe('scanned');
    });
  });

  /**
   * Historia "Crear un trabajo de indexación al encolar el evento document.index": cada evento
   * encolado deja exactamente un job en `PENDING`, escrito con el mismo `manager` de la transacción.
   */
  describe('enqueue', () => {
    it('documento indexable: registra el evento y un job PENDING con el manager de la transacción', async () => {
      const result = await service.enqueue(
        manager as never,
        organizationDocument,
        'Acme',
        'user-1',
      );

      expect(documentEventsProducer.enqueueIndexRequested).toHaveBeenCalledWith(
        manager,
        service.buildPayload(organizationDocument, 'Acme'),
        'user-1',
      );
      expect(manager.getRepository).toHaveBeenCalledWith(
        DocumentIndexingJobEntity,
      );
      expect(jobRepository.save).toHaveBeenCalledTimes(1);
      expect(jobRepository.create).toHaveBeenCalledWith({
        documentId: 'doc-1',
        status: DOCUMENT_INDEXING_STATUS_ENUM.PENDING,
        attemptCount: 0,
        externalJobId: null,
        receivedAt: null,
        completedAt: null,
        error: null,
        metadata: {
          originType: 'digital_native',
          originReference: 'created-documents/a1b2c3.pdf',
          organizationId: 'org-1',
          organizationName: 'Acme',
          clientDocumentId: 'doc-1',
          createdAt: '2026-10-30T12:00:00.000Z',
        },
      });
      expect(result).toEqual({
        event: { id: 'event-1' },
        job: expect.objectContaining({
          id: 'job-1',
          status: DOCUMENT_INDEXING_STATUS_ENUM.PENDING,
        }),
      });
    });

    it('documento personal: el job guarda organización e id de organización en null', async () => {
      await service.enqueue(manager as never, personalDocument, null, 'user-1');

      expect(jobRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          documentId: 'doc-2',
          metadata: expect.objectContaining({
            organizationId: null,
            organizationName: null,
            clientDocumentId: 'doc-2',
          }),
        }),
      );
    });

    /**
     * La `metadata` del job es una copia del payload enviado, no una segunda lectura del documento:
     * los campos compartidos tienen que coincidir uno a uno.
     */
    it('la metadata del job coincide con lo enviado al indexador', async () => {
      await service.enqueue(
        manager as never,
        organizationDocument,
        'Acme',
        'user-1',
      );

      const [, payload] =
        documentEventsProducer.enqueueIndexRequested.mock.calls[0];
      const { metadata } = jobRepository.create.mock.calls[0][0];
      expect(metadata).toStrictEqual({
        originType: payload.originType,
        originReference: payload.originReference,
        organizationId: payload.metadata.organizationId,
        organizationName: payload.organization,
        clientDocumentId: payload.clientDocumentId,
        createdAt: payload.metadata.createdAt,
      });
    });

    it('documento no indexable: no registra evento ni job', async () => {
      const result = await service.enqueue(
        manager as never,
        { ...organizationDocument, isIndexable: false },
        'Acme',
        'user-1',
      );

      expect(result).toBeNull();
      expect(
        documentEventsProducer.enqueueIndexRequested,
      ).not.toHaveBeenCalled();
      expect(jobRepository.save).not.toHaveBeenCalled();
    });

    /**
     * Si el job no se puede guardar, el error sube y revierte la transacción del llamador, que se
     * lleva consigo el evento ya encolado: nunca queda un evento sin su job.
     */
    it('si guardar el job falla, propaga el error para revertir la transacción', async () => {
      jobRepository.save.mockRejectedValue(new Error('insert fallido'));

      await expect(
        service.enqueue(
          manager as never,
          organizationDocument,
          'Acme',
          'user-1',
        ),
      ).rejects.toThrow('insert fallido');
    });
  });

  describe('configuración', () => {
    it.each(['', '   ', undefined])(
      'sin DOCUMENT_INDEX_ORIGIN_TYPE (%p) no se puede instanciar',
      (value) => {
        if (value === undefined) delete process.env.DOCUMENT_INDEX_ORIGIN_TYPE;
        else process.env.DOCUMENT_INDEX_ORIGIN_TYPE = value;

        expect(
          () =>
            new DocumentIndexRequestService(
              documentEventsProducer as unknown as DocumentEventsProducer,
            ),
        ).toThrow(/DOCUMENT_INDEX_ORIGIN_TYPE/);
      },
    );

    it('sin MINIO_CREATED_DOCUMENTS_BUCKET no se puede instanciar', () => {
      delete process.env.MINIO_CREATED_DOCUMENTS_BUCKET;

      expect(
        () =>
          new DocumentIndexRequestService(
            documentEventsProducer as unknown as DocumentEventsProducer,
          ),
      ).toThrow(/MINIO_CREATED_DOCUMENTS_BUCKET/);
    });
  });
});
