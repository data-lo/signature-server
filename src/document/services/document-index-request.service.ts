import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import { DocumentEventsProducer } from 'src/kafka/document-events.producer';
import { DocumentIndexEventPayload } from 'src/kafka/document-events.topics';
import { EventEntity } from 'src/event/entities/event.entity';

import { DocumentEntity } from '../entities/document.entity';

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
 * Solicita al servicio externo de indexación (Búsqueda Inteligente) que indexe un documento,
 * publicando `document.index` a través de la outbox transaccional.
 *
 * Valida su configuración en el constructor, como `MinioService`: Nest lo instancia al arrancar,
 * así que una variable faltante impide levantar la aplicación en lugar de aparecer en la primera
 * creación de un documento.
 *
 * El estado del trabajo de indexación (`DocumentIndexingJobEntity`) y la respuesta del indexador
 * quedan fuera: esto sólo pide la indexación.
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
   * Registra la solicitud de indexación en la outbox, dentro de la transacción que crea el
   * documento, si y sólo si el documento es indexable.
   *
   * La publicación real la hace el `flush` de la outbox después del commit: si la transacción se
   * revierte, la fila desaparece con ella y el indexador nunca se entera.
   *
   * @param manager - `EntityManager` de la transacción que crea el documento.
   * @param document - Documento ya guardado en esa transacción.
   * @param organizationName - Nombre de su organización; `null` en documentos personales.
   * @param actorUserId - Usuario que creó el documento.
   * @returns El evento registrado, o `null` si el documento no es indexable.
   *
   * @throws {QueryFailedError} Si la inserción en la outbox falla; revierte la transacción.
   *
   * @example
   * ```ts
   * await this.documentIndexRequest.enqueue(manager, document, 'Acme', createdBy);
   * ```
   */
  async enqueue(
    manager: EntityManager,
    document: IndexableDocument,
    organizationName: string | null,
    actorUserId: string,
  ): Promise<EventEntity | null> {
    if (document.isIndexable !== true) return null;

    return this.documentEventsProducer.enqueueIndexRequested(
      manager,
      this.buildPayload(document, organizationName),
      actorUserId,
    );
  }
}
