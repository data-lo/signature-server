import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import { DocumentEventsProducer } from 'src/kafka/document-events.producer';
import { DocumentIndexEventPayload } from 'src/kafka/document-events.topics';
import { EventEntity } from 'src/event/entities/event.entity';

import { DocumentEntity } from '../entities/document.entity';
import { DocumentIndexingJobEntity } from '../entities/document-indexing-job.entity';
import { DOCUMENT_INDEXING_STATUS_ENUM } from '../enum/document-indexing-status.enum';

/** Lo mínimo del documento que necesita el contrato del indexador. */
export type IndexableDocument = Pick<
  DocumentEntity,
  | 'id'
  | 'objectKey'
  | 'organizationId'
  | 'createdAt'
  | 'signedAt'
  | 'isIndexable'
>;

/**
 * Copia del contexto enviado al indexador que se guarda en `document_indexing_jobs.metadata`, para
 * revisar, reintentar o auditar la solicitud aunque después cambie el documento o la organización.
 */
export interface DocumentIndexingJobMetadata extends Record<string, unknown> {
  originType: string;
  originReference: string;
  organizationId: string | null;
  organizationName: string | null;
  clientDocumentId: string;
  /** ISO 8601 de `documents.created_at`. */
  createdAt: string;
}

/** Lo que deja registrado una solicitud de indexación: el evento de la outbox y su job. */
export interface DocumentIndexRequest {
  event: EventEntity;
  job: DocumentIndexingJobEntity;
}

/**
 * Solicita al servicio externo de indexación (Búsqueda Inteligente) que indexe un documento,
 * publicando `document.index` a través de la outbox transaccional.
 *
 * Valida su configuración en el constructor, como `MinioService`: Nest lo instancia al arrancar,
 * así que una variable faltante impide levantar la aplicación en lugar de aparecer en la primera
 * creación de un documento.
 *
 * Cada solicitud deja además un `DocumentIndexingJobEntity` en `PENDING`, en la misma transacción
 * que el evento: es lo que permitirá procesar la respuesta del indexador. Esa respuesta —y los
 * estados `RECEIVED`, `INDEXED` y `FAILED`— queda fuera: esto sólo pide la indexación.
 */
@Injectable()
export class DocumentIndexRequestService {
  private readonly originType: string;
  private readonly createdDocumentsBucket: string;

  /**
   * Lee y valida `DOCUMENT_INDEX_ORIGIN_TYPE` y `MINIO_CREATED_DOCUMENTS_BUCKET`.
   *
   * @param documentEventsProducer - Productor que registra el evento en la outbox.
   *
   * @throws {Error} Si alguna de las dos variables falta o está vacía.
   *
   * @example
   * ```ts
   * // DOCUMENT_INDEX_ORIGIN_TYPE=digital_native, MINIO_CREATED_DOCUMENTS_BUCKET=created-documents
   * const service = new DocumentIndexRequestService(documentEventsProducer);
   * ```
   */
  constructor(private readonly documentEventsProducer: DocumentEventsProducer) {
    const originType = process.env.DOCUMENT_INDEX_ORIGIN_TYPE?.trim();
    if (!originType) {
      throw new Error(
        '¡DOCUMENT_INDEX_ORIGIN_TYPE no está definida en las variables de entorno!',
      );
    }

    const createdDocumentsBucket =
      process.env.MINIO_CREATED_DOCUMENTS_BUCKET?.trim();
    if (!createdDocumentsBucket) {
      throw new Error(
        '¡MINIO_CREATED_DOCUMENTS_BUCKET no está definida en las variables de entorno!',
      );
    }

    this.originType = originType;
    this.createdDocumentsBucket = createdDocumentsBucket;
  }

  /**
   * Arma el cuerpo de `document.index` a partir del documento guardado.
   *
   * `originReference` es la ubicación interna del archivo (bucket + `objectKey`), nunca una URL
   * prefirmada. `signedAt` sale tal cual del documento: al crearlo es `null`, y no se inventa.
   *
   * @param document - Documento ya persistido (con `id` y `createdAt`).
   * @param organizationName - Nombre de su organización; `null` en documentos personales.
   * @returns El contrato del indexador, sin campos extra.
   *
   * @example
   * ```ts
   * service.buildPayload(document, 'Acme');
   * // { organization: 'Acme', originType: 'digital_native',
   * //   originReference: 'created-documents/abc.pdf', clientDocumentId: document.id,
   * //   metadata: { organizationId: 'org-1', createdAt: '2026-10-30T12:00:00.000Z', signedAt: null } }
   * ```
   */
  buildPayload(
    document: IndexableDocument,
    organizationName: string | null,
  ): DocumentIndexEventPayload {
    const organizationId = document.organizationId ?? null;

    return {
      // Sin organización no hay nombre que publicar, aunque el llamador mande uno.
      organization: organizationId ? organizationName : null,
      originType: this.originType,
      originReference: `${this.createdDocumentsBucket}/${document.objectKey}`,
      clientDocumentId: document.id,
      metadata: {
        organizationId,
        createdAt: document.createdAt.toISOString(),
        signedAt: document.signedAt ? document.signedAt.toISOString() : null,
      },
    };
  }

  /**
   * Arma la `metadata` del job a partir del payload que se envía al indexador, para que sea una
   * copia fiel de lo enviado y no una segunda lectura del documento.
   *
   * @param payload - Cuerpo de `document.index` ya armado.
   * @returns La copia que se guarda en el job.
   *
   * @example
   * ```ts
   * service.buildJobMetadata(service.buildPayload(document, 'Acme'));
   * // { originType: 'digital_native', originReference: 'created-documents/abc.pdf',
   * //   organizationId: 'org-1', organizationName: 'Acme', clientDocumentId: document.id,
   * //   createdAt: '2026-10-30T12:00:00.000Z' }
   * ```
   */
  buildJobMetadata(
    payload: DocumentIndexEventPayload,
  ): DocumentIndexingJobMetadata {
    return {
      originType: payload.originType,
      originReference: payload.originReference,
      organizationId: payload.metadata.organizationId,
      organizationName: payload.organization,
      clientDocumentId: payload.clientDocumentId,
      createdAt: payload.metadata.createdAt,
    };
  }

  /**
   * Registra la solicitud de indexación —el evento `document.index` en la outbox y su
   * `DocumentIndexingJobEntity` en `PENDING`— dentro de la transacción que crea el documento, si y
   * sólo si el documento es indexable.
   *
   * Las dos filas se escriben con el mismo `manager`: si la transacción se revierte, desaparecen
   * con el documento. La publicación real la hace el `flush` de la outbox después del commit, así
   * que el job existe antes de que el indexador pueda responder.
   *
   * @param manager - `EntityManager` de la transacción que crea el documento.
   * @param document - Documento ya guardado en esa transacción.
   * @param organizationName - Nombre de su organización; `null` en documentos personales.
   * @param actorUserId - Usuario que creó el documento.
   * @returns El evento y el job registrados, o `null` si el documento no es indexable.
   *
   * @throws {QueryFailedError} Si falla la inserción del evento o del job; revierte la transacción.
   *
   * @example
   * ```ts
   * const request = await this.documentIndexRequest.enqueue(manager, document, 'Acme', createdBy);
   * request?.job.status; // 'PENDING'
   * ```
   */
  async enqueue(
    manager: EntityManager,
    document: IndexableDocument,
    organizationName: string | null,
    actorUserId: string,
  ): Promise<DocumentIndexRequest | null> {
    if (document.isIndexable !== true) return null;

    const payload = this.buildPayload(document, organizationName);
    const event = await this.documentEventsProducer.enqueueIndexRequested(
      manager,
      payload,
      actorUserId,
    );

    const jobRepository = manager.getRepository(DocumentIndexingJobEntity);
    const job = await jobRepository.save(
      jobRepository.create({
        documentId: document.id,
        status: DOCUMENT_INDEXING_STATUS_ENUM.PENDING,
        attemptCount: 0,
        // Se llenan al recibir la respuesta del indexador (fuera de esta tarea).
        externalJobId: null,
        receivedAt: null,
        completedAt: null,
        error: null,
        metadata: this.buildJobMetadata(payload),
      }),
    );

    return { event, job };
  }
}
