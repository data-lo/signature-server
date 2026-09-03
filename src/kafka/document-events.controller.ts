import { Controller } from '@nestjs/common';
import { EventPattern, Payload } from '@nestjs/microservices';

import {
  DOCUMENT_KAFKA_TOPICS,
  DocumentEventPayload,
  DocumentCollaboratorSignedPayload,
} from './document-events.topics';

import { ProcessDocumentCreatedEventUseCase } from './applications/process-document-created-event.use-case';
import { ProcessDocumentSentToSignEventUseCase } from './applications/process-document-sent-to-sign-event.use-case';
import { ProcessDocumentCollaboratorSignedEventUseCase } from './applications/process-document-collaborator-signed-event.use-case';
import { ProcessDocumentSignedEventUseCase } from './applications/process-document-signed-event.use-case';
import { ProcessDocumentRejectedEventUseCase } from './applications/process-document-rejected-event.use-case';
import { ProcessDocumentCancellationRequestedEventUseCase } from './applications/process-document-cancellation-requested-event.use-case';
import { ProcessDocumentCancelledEventUseCase } from './applications/process-document-cancelled-event.use-case';

/**
 * Consume los eventos de negocio del ciclo de vida del documento. Es un adaptador de Kafka y nada
 * más: cada tópico delega en un único caso de uso de `applications/`, igual que un controller HTTP.
 *
 * Todos los tópicos viven en el mismo `@Controller` a propósito: NestJS sólo permite UN handler por
 * patrón de Kafka dentro de un microservicio —los registra en un Map por patrón, así que un segundo
 * `@Controller` con el mismo `@EventPattern` pisaría a éste en vez de correr ambos—, y repartirlos
 * rompería en silencio el procesamiento de los tópicos duplicados.
 */
@Controller()
export class DocumentEventsConsumer {
  constructor(
    private readonly processCreated: ProcessDocumentCreatedEventUseCase,
    private readonly processSentToSign: ProcessDocumentSentToSignEventUseCase,
    private readonly processCollaboratorSigned: ProcessDocumentCollaboratorSignedEventUseCase,
    private readonly processSigned: ProcessDocumentSignedEventUseCase,
    private readonly processRejected: ProcessDocumentRejectedEventUseCase,
    private readonly processCancellationRequested: ProcessDocumentCancellationRequestedEventUseCase,
    private readonly processCancelled: ProcessDocumentCancelledEventUseCase,
  ) {}

  @EventPattern(DOCUMENT_KAFKA_TOPICS.CREATED)
  async handleCreated(@Payload() payload: DocumentEventPayload) {
    await this.processCreated.execute(payload);
  }

  @EventPattern(DOCUMENT_KAFKA_TOPICS.SENT_TO_SIGN)
  async handleSentToSign(@Payload() payload: DocumentEventPayload) {
    await this.processSentToSign.execute(payload);
  }

  @EventPattern(DOCUMENT_KAFKA_TOPICS.COLLABORATOR_SIGNED)
  async handleCollaboratorSigned(
    @Payload() payload: DocumentCollaboratorSignedPayload,
  ) {
    await this.processCollaboratorSigned.execute(payload);
  }

  @EventPattern(DOCUMENT_KAFKA_TOPICS.SIGNED)
  async handleSigned(@Payload() payload: DocumentEventPayload) {
    await this.processSigned.execute(payload);
  }

  @EventPattern(DOCUMENT_KAFKA_TOPICS.REJECTED)
  async handleRejected(@Payload() payload: DocumentEventPayload) {
    await this.processRejected.execute(payload);
  }

  @EventPattern(DOCUMENT_KAFKA_TOPICS.CANCELLATION_REQUESTED)
  async handleCancellationRequested(@Payload() payload: DocumentEventPayload) {
    await this.processCancellationRequested.execute(payload);
  }

  @EventPattern(DOCUMENT_KAFKA_TOPICS.CANCELLED)
  async handleCancelled(@Payload() payload: DocumentEventPayload) {
    await this.processCancelled.execute(payload);
  }
}
