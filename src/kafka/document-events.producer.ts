import { Injectable } from '@nestjs/common';
import { KafkaProducerService } from './kafka-producer.service';
import {
  DOCUMENT_KAFKA_TOPICS,
  DocumentEventPayload,
} from './document-events.topics';

interface EmitDocumentEventParams {
  documentId: string;
  fileName: string;
  actorUserId: string;
}

/** Publica los eventos de negocio del ciclo de vida del documento (creado, enviado a firma, firmado, rechazado, cancelado). */
@Injectable()
export class DocumentEventsProducer {
  constructor(private readonly kafkaProducer: KafkaProducerService) {}

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
