import { Injectable, Logger } from '@nestjs/common';
import { KafkaProducerService } from './kafka-producer.service';
import {
  DOCUMENT_KAFKA_TOPICS,
  DocumentEventPayload,
  DocumentCollaboratorSignedPayload,
} from './document-events.topics';
import { EventService } from 'src/event/event.service';
import { EVENT_TYPE_ENUM } from 'src/event/enums/event-type.enum';
import { EntityManager } from 'typeorm';
import { OutboxService } from 'src/event/outbox.service';
import { EventEntity } from 'src/event/entities/event.entity';

interface EmitDocumentEventParams {
  documentId: string;
  fileName: string;
  actorUserId: string;
}

interface EmitCollaboratorSignedParams extends EmitDocumentEventParams {
  collaboratorId: string;
  signedAt: string;
}

interface EmitApprovalEventParams extends EmitDocumentEventParams {
  /** Colaborador REVIEWER del documento. */
  collaboratorId: string;
  resolutionNote?: string | null;
}

/**
 * Mapeo explícito tópico Kafka -> tipo de evento persistido (ver EventModule) — evitar acoplar
 * ambos enums por coincidencia de string, aunque hoy compartan los mismos valores.
 */
const TOPIC_TO_EVENT_TYPE: Record<DOCUMENT_KAFKA_TOPICS, EVENT_TYPE_ENUM> = {
  [DOCUMENT_KAFKA_TOPICS.CREATED]: EVENT_TYPE_ENUM.DOCUMENT_CREATED,
  [DOCUMENT_KAFKA_TOPICS.APPROVAL_REQUESTED]:
    EVENT_TYPE_ENUM.DOCUMENT_APPROVAL_REQUESTED,
  [DOCUMENT_KAFKA_TOPICS.APPROVED]: EVENT_TYPE_ENUM.DOCUMENT_APPROVED,
  [DOCUMENT_KAFKA_TOPICS.APPROVAL_REJECTED]:
    EVENT_TYPE_ENUM.DOCUMENT_APPROVAL_REJECTED,
  [DOCUMENT_KAFKA_TOPICS.SENT_TO_SIGN]: EVENT_TYPE_ENUM.DOCUMENT_SENT_TO_SIGN,
  [DOCUMENT_KAFKA_TOPICS.COLLABORATOR_SIGNED]:
    EVENT_TYPE_ENUM.DOCUMENT_COLLABORATOR_SIGNED,
  [DOCUMENT_KAFKA_TOPICS.SIGNED]: EVENT_TYPE_ENUM.DOCUMENT_SIGNED,
  [DOCUMENT_KAFKA_TOPICS.REJECTED]: EVENT_TYPE_ENUM.DOCUMENT_REJECTED,
  [DOCUMENT_KAFKA_TOPICS.CANCELLATION_REQUESTED]:
    EVENT_TYPE_ENUM.DOCUMENT_CANCELLATION_REQUESTED,
  [DOCUMENT_KAFKA_TOPICS.CANCELLED]: EVENT_TYPE_ENUM.DOCUMENT_CANCELLED,
};

/** Publica los eventos de negocio del ciclo de vida del documento (creado, enviado a firma, firmado, rechazado, cancelado). */
@Injectable()
export class DocumentEventsProducer {
  private readonly logger = new Logger(DocumentEventsProducer.name);

  constructor(
    private readonly kafkaProducer: KafkaProducerService,
    private readonly eventService: EventService,
    private readonly outboxService: OutboxService,
  ) {}

  private emitEvent(
    topic: DOCUMENT_KAFKA_TOPICS,
    { documentId, fileName, actorUserId }: EmitDocumentEventParams,
  ) {
    const payload: DocumentEventPayload = {
      documentId,
      fileName,
      actorUserId,
      occurredAt: new Date().toISOString(),
    };
    this.kafkaProducer.emit(topic, payload);

    // Registro en Postgres para trazabilidad (EventModule), independiente de Kafka: un fallo
    // aquí no debe tumbar el publish real ni la petición HTTP que lo disparó — solo se loguea.
    // metadata (no una FK real) es lo que el diagrama ER-V2 marca para correlacionar el evento
    // con su documento, ver docblock de EventEntity.
    this.eventService
      .create({
        eventType: TOPIC_TO_EVENT_TYPE[topic],
        metadata: { documentId, fileName },
        from: actorUserId,
      })
      .catch((error) =>
        this.logger.error(
          `Error persistiendo el evento '${topic}' del documento ${documentId}: ${error}`,
        ),
      );
  }

  emitCreated(params: EmitDocumentEventParams) {
    this.emitEvent(DOCUMENT_KAFKA_TOPICS.CREATED, params);
  }

  emitSentToSign(params: EmitDocumentEventParams) {
    this.emitEvent(DOCUMENT_KAFKA_TOPICS.SENT_TO_SIGN, params);
  }

  /**
   * Registra un evento de aprobación en la outbox, dentro de la transacción del llamador.
   *
   * Los tres eventos del flujo de aprobación pasan por aquí y no por `emitEvent` porque acompañan
   * un cambio de estado del documento: anunciarlos antes de que la transacción confirme sería
   * anunciar algo que todavía puede deshacerse. El resto de los eventos sigue publicándose por el
   * camino directo; migrarlos es un cambio de comportamiento que esta historia no pide.
   *
   * Los tres comparten método porque comparten forma —documento + reviewer + actor—: lo único que
   * cambia entre ellos es el tópico y, en el rechazo, el comentario del reviewer.
   *
   * @param manager - `EntityManager` de la transacción que cambia el estado.
   * @param topic - Cuál de los tres eventos de aprobación.
   * @param params - Documento, reviewer, actor y la nota de resolución si aplica.
   * @returns El evento registrado; su `id` es el `eventId` que viajará en el sobre.
   *
   * @throws {QueryFailedError} Si la inserción falla — propaga y revierte la transacción, que es
   *   lo correcto: sin evento registrado el cambio de estado no debe confirmarse.
   *
   * @example
   * ```ts
   * await producer.enqueueApprovalEvent(manager, DOCUMENT_KAFKA_TOPICS.APPROVED, {
   *   documentId, fileName, actorUserId, collaboratorId,
   * });
   * ```
   */
  async enqueueApprovalEvent(
    manager: EntityManager,
    topic:
      | DOCUMENT_KAFKA_TOPICS.APPROVAL_REQUESTED
      | DOCUMENT_KAFKA_TOPICS.APPROVED
      | DOCUMENT_KAFKA_TOPICS.APPROVAL_REJECTED,
    {
      documentId,
      fileName,
      actorUserId,
      collaboratorId,
      resolutionNote,
    }: EmitApprovalEventParams,
  ): Promise<EventEntity> {
    return this.outboxService.enqueue(manager, {
      eventType: TOPIC_TO_EVENT_TYPE[topic],
      topic,
      body: {
        documentId,
        fileName,
        collaboratorId,
        resolutionNote: resolutionNote ?? null,
      },
      from: actorUserId,
    });
  }

  /**
   * Publica lo que la outbox tenga pendiente. Se llama DESPUÉS de confirmar la transacción.
   *
   * @returns Nada: es best-effort; lo que falle se queda pendiente y lo reintenta el siguiente
   *   `flushOutbox` (ver `OutboxService`).
   *
   * @example
   * ```ts
   * await producer.flushOutbox();
   * ```
   */
  async flushOutbox(): Promise<void> {
    await this.outboxService.flush();
  }

  /**
   * A diferencia de emitSigned (solo cuando el ÚLTIMO firmante termina), esto se dispara por
   * CADA colaborador que firma — alimenta el encadenamiento de DocumentTransaction (ver
   * DocumentEventsConsumer.handleCollaboratorSigned).
   */
  emitCollaboratorSigned({
    documentId,
    fileName,
    actorUserId,
    collaboratorId,
    signedAt,
  }: EmitCollaboratorSignedParams) {
    const payload: DocumentCollaboratorSignedPayload = {
      documentId,
      fileName,
      actorUserId,
      collaboratorId,
      signedAt,
      occurredAt: new Date().toISOString(),
    };
    this.kafkaProducer.emit(DOCUMENT_KAFKA_TOPICS.COLLABORATOR_SIGNED, payload);

    this.eventService
      .create({
        eventType: EVENT_TYPE_ENUM.DOCUMENT_COLLABORATOR_SIGNED,
        metadata: { documentId, fileName, collaboratorId },
        from: actorUserId,
      })
      .catch((error) =>
        this.logger.error(
          `Error persistiendo el evento 'document.collaborator_signed' del documento ${documentId}: ${error}`,
        ),
      );
  }

  emitSigned(params: EmitDocumentEventParams) {
    this.emitEvent(DOCUMENT_KAFKA_TOPICS.SIGNED, params);
  }

  emitRejected(params: EmitDocumentEventParams) {
    this.emitEvent(DOCUMENT_KAFKA_TOPICS.REJECTED, params);
  }

  emitCancellationRequested(params: EmitDocumentEventParams) {
    this.emitEvent(DOCUMENT_KAFKA_TOPICS.CANCELLATION_REQUESTED, params);
  }

  emitCancelled(params: EmitDocumentEventParams) {
    this.emitEvent(DOCUMENT_KAFKA_TOPICS.CANCELLED, params);
  }
}
