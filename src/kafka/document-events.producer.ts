import { Injectable, Logger } from '@nestjs/common';
import { KafkaProducerService } from './kafka-producer.service';
import {
  DOCUMENT_KAFKA_TOPICS,
  DocumentEventPayload,
} from './document-events.topics';
import { EventService } from 'src/event/event.service';
import { EVENT_TYPE_ENUM } from 'src/event/enums/event-type.enum';

interface EmitDocumentEventParams {
  documentId: string;
  fileName: string;
  actorUserId: string;
}

/**
 * Mapeo explícito tópico Kafka -> tipo de evento persistido (ver EventModule) — evitar acoplar
 * ambos enums por coincidencia de string, aunque hoy compartan los mismos valores.
 */
const TOPIC_TO_EVENT_TYPE: Record<DOCUMENT_KAFKA_TOPICS, EVENT_TYPE_ENUM> = {
  [DOCUMENT_KAFKA_TOPICS.CREATED]: EVENT_TYPE_ENUM.DOCUMENT_CREATED,
  [DOCUMENT_KAFKA_TOPICS.SENT_TO_SIGN]: EVENT_TYPE_ENUM.DOCUMENT_SENT_TO_SIGN,
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
  ) {}

  private emitEvent(
    topic: DOCUMENT_KAFKA_TOPICS,
    { documentId, fileName, actorUserId }: EmitDocumentEventParams,
  ) {
    const payload: DocumentEventPayload = {
      documentId,
      fileName,
      actorUserId,
      timestamp: new Date().toISOString(),
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
