import { Controller, Logger } from '@nestjs/common';
import { EventPattern, Payload } from '@nestjs/microservices';
import {
  DOCUMENT_KAFKA_TOPICS,
  DocumentEventPayload,
} from './document-events.topics';

/** Consumidor real de los eventos de negocio del ciclo de vida del documento (ver DocumentEventsProducer). */
@Controller()
export class DocumentEventsConsumer {
  private readonly logger = new Logger(DocumentEventsConsumer.name);

  @EventPattern(DOCUMENT_KAFKA_TOPICS.CREATED)
  handleCreated(@Payload() payload: DocumentEventPayload) {
    this.logEvent('creado', payload);
  }

  @EventPattern(DOCUMENT_KAFKA_TOPICS.SENT_TO_SIGN)
  handleSentToSign(@Payload() payload: DocumentEventPayload) {
    this.logEvent('enviado a firma', payload);
  }

  @EventPattern(DOCUMENT_KAFKA_TOPICS.SIGNED)
  handleSigned(@Payload() payload: DocumentEventPayload) {
    this.logEvent('firmado', payload);
  }

  @EventPattern(DOCUMENT_KAFKA_TOPICS.REJECTED)
  handleRejected(@Payload() payload: DocumentEventPayload) {
    this.logEvent('rechazado', payload);
  }

  @EventPattern(DOCUMENT_KAFKA_TOPICS.CANCELLED)
  handleCancelled(@Payload() payload: DocumentEventPayload) {
    this.logEvent('cancelado', payload);
  }

  private logEvent(action: string, payload: DocumentEventPayload) {
    this.logger.log(
      `Documento ${action}: ${payload.documentId} ("${payload.fileName}") por ${payload.actorUserId} @ ${payload.timestamp}`,
    );
  }
}
