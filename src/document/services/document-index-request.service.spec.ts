import { DocumentEventsProducer } from 'src/kafka/document-events.producer';

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
  const manager = {} as never;

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

  describe('enqueue', () => {
    it('documento indexable: lo registra en la outbox con el manager de la transacción', async () => {
      const result = await service.enqueue(
        manager,
        organizationDocument,
        'Acme',
        'user-1',
      );

      expect(result).toEqual({ id: 'event-1' });
      expect(documentEventsProducer.enqueueIndexRequested).toHaveBeenCalledWith(
        manager,
        service.buildPayload(organizationDocument, 'Acme'),
        'user-1',
      );
    });

    it('documento no indexable: no registra nada', async () => {
      const result = await service.enqueue(
        manager,
        { ...organizationDocument, isIndexable: false },
        'Acme',
        'user-1',
      );

      expect(result).toBeNull();
      expect(
        documentEventsProducer.enqueueIndexRequested,
      ).not.toHaveBeenCalled();
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
