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
import { IdempotencyService } from 'src/event/idempotency.service';

/**
 * Consumidor de los eventos de negocio del ciclo de vida del documento (ver
 * `DocumentEventsProducer`). Es un adaptador de Kafka y nada más: cada tópico delega en un
 * único caso de uso de `applications/`, igual que un controller HTTP delega en el suyo.
 *
 * Todos los tópicos viven en el mismo `@Controller` a propósito: NestJS sólo permite UN handler
 * por patrón de Kafka dentro de un mismo microservicio (`@nestjs/microservices` los registra en
 * un Map por patrón — un segundo `@Controller` con el mismo `@EventPattern` simplemente pisaría
 * a éste, no correrían ambos). Repartirlos en varios consumidores rompería silenciosamente el
 * procesamiento de los tópicos duplicados.
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
    private readonly idempotency: IdempotencyService,
  ) {}

  /**
   * Nombre con el que este consumidor marca los eventos que ya procesó. Es una constante y no
   * `DocumentEventsConsumer.name`: renombrar la clase no debe hacer que se reprocese todo el
   * pasado.
   */
  private static readonly CONSUMER_NAME = 'document-events';

  /**
   * Corre el trabajo del evento sólo si nadie lo hizo ya.
   *
   * Kafka entrega al menos una vez y la outbox puede republicar lo que no confirmó (ver
   * `OutboxService`), así que la reentrega del mismo `eventId` es un caso normal, no una anomalía.
   * Sin esta guarda, una reentrega encadenaría dos veces la misma transacción de auditoría.
   *
   * @param payload - Sobre del evento; su `eventId` es la llave de deduplicación.
   * @param handle - Trabajo a realizar si el evento es nuevo para este consumidor.
   * @returns Nada.
   *
   * @example
   * ```ts
   * await this.once(payload, () => this.processCreated.execute(payload));
   * ```
   */
  private async once(
    payload: DocumentEventPayload,
    handle: () => Promise<void>,
  ): Promise<void> {
    const claimed = await this.idempotency.claim(
      payload.eventId,
      DocumentEventsConsumer.CONSUMER_NAME,
    );
    if (!claimed) return;

    await handle();
  }

  @EventPattern(DOCUMENT_KAFKA_TOPICS.CREATED)
  async handleCreated(@Payload() payload: DocumentEventPayload) {
    await this.once(payload, () => this.processCreated.execute(payload));
  }

  @EventPattern(DOCUMENT_KAFKA_TOPICS.SENT_TO_SIGN)
  async handleSentToSign(@Payload() payload: DocumentEventPayload) {
    await this.once(payload, () => this.processSentToSign.execute(payload));
  }

  @EventPattern(DOCUMENT_KAFKA_TOPICS.COLLABORATOR_SIGNED)
  async handleCollaboratorSigned(
    @Payload() payload: DocumentCollaboratorSignedPayload,
  ) {
    await this.once(payload, () =>
      this.processCollaboratorSigned.execute(payload),
    );
  }

  @EventPattern(DOCUMENT_KAFKA_TOPICS.SIGNED)
  async handleSigned(@Payload() payload: DocumentEventPayload) {
    await this.once(payload, () => this.processSigned.execute(payload));
  }

  @EventPattern(DOCUMENT_KAFKA_TOPICS.REJECTED)
  async handleRejected(@Payload() payload: DocumentEventPayload) {
    await this.once(payload, () => this.processRejected.execute(payload));
  }

  @EventPattern(DOCUMENT_KAFKA_TOPICS.CANCELLATION_REQUESTED)
  async handleCancellationRequested(@Payload() payload: DocumentEventPayload) {
    await this.once(payload, () =>
      this.processCancellationRequested.execute(payload),
    );
  }

  @EventPattern(DOCUMENT_KAFKA_TOPICS.CANCELLED)
  async handleCancelled(@Payload() payload: DocumentEventPayload) {
    await this.once(payload, () => this.processCancelled.execute(payload));
  }
}
