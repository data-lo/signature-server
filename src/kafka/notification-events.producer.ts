import { Injectable, Logger } from '@nestjs/common';
import { KafkaProducerService } from './kafka-producer.service';
import {
  NOTIFICATION_KAFKA_TOPICS,
  NotificationEventPayload,
} from './notification-events.topics';
import { EventService } from 'src/event/event.service';
import { EVENT_TYPE_ENUM } from 'src/event/enums/event-type.enum';
import { OutboxService } from 'src/event/outbox.service';
import { EntityManager } from 'typeorm';

interface EmitNotificationCreatedParams {
  notificationId: string;
  documentId: string;
  collaboratorId: string;
  actorType: string;
  notificationChannelSource: string;
  /** Quien disparó la creación del documento/flujo de firmas (no el destinatario de la notificación). */
  actorUserId: string;
}

/**
 * Publica un evento por cada `Notification` creada durante la orquestación de
 * `POST /api/v1/documents/signatures` (ver CreateDocumentSignatureFlowUseCase) — a diferencia de
 * `DocumentEventsProducer` (eventos del ciclo de vida del documento, uno por documento), este
 * tópico es uno por notificación/colaborador, pensado para que N workers de correo lo consuman
 * de forma asíncrona y disparen el envío real.
 */
@Injectable()
export class NotificationEventsProducer {
  private readonly logger = new Logger(NotificationEventsProducer.name);

  constructor(
    private readonly kafkaProducer: KafkaProducerService,
    private readonly eventService: EventService,
    private readonly outboxService: OutboxService,
  ) {}

  /**
   * Registra `notification.created` en la outbox, dentro de la transacción que crea la notificación.
   *
   * Es la variante transaccional de `emitCreated` (historia "Implementar creación transaccional de
   * colaboradores desde Directorio y captura manual"): si la transacción revierte, el evento
   * desaparece con ella y nadie recibe un correo de un documento que no existe; si confirma, lo
   * publica `OutboxService.flush` después del commit y lo consume
   * `SendPendingSignatureNotificationUseCase`, que es quien manda el correo. El cuerpo es el mismo
   * `NotificationEventPayload` que publica `emitCreated`, así que el consumidor no distingue el
   * camino. La fila de `events` que antes escribía `EventService` aparte es ahora la propia fila de
   * la outbox.
   *
   * @param manager - `EntityManager` de la transacción que crea la notificación.
   * @param params - Notificación, documento, colaborador y actor.
   * @returns Nada.
   *
   * @throws {QueryFailedError} Si no se puede escribir la fila; revierte la transacción del
   *   llamador, que es lo correcto: sin evento, la notificación no saldría nunca.
   *
   * @example
   * ```ts
   * await producer.enqueueCreated(manager, {
   *   notificationId, documentId, collaboratorId,
   *   actorType: 'WATCHER', notificationChannelSource: 'EMAIL', actorUserId: 'user-1',
   * });
   * ```
   */
  async enqueueCreated(
    manager: EntityManager,
    { actorUserId, ...params }: EmitNotificationCreatedParams,
  ): Promise<void> {
    const body: NotificationEventPayload = {
      ...params,
      timestamp: new Date().toISOString(),
    };
    await this.outboxService.enqueue(manager, {
      eventType: EVENT_TYPE_ENUM.NOTIFICATION_CREATED,
      topic: NOTIFICATION_KAFKA_TOPICS.CREATED,
      body: { ...body },
      from: actorUserId,
    });
  }

  emitCreated({ actorUserId, ...params }: EmitNotificationCreatedParams) {
    const payload: NotificationEventPayload = {
      ...params,
      timestamp: new Date().toISOString(),
    };
    this.kafkaProducer.emit(NOTIFICATION_KAFKA_TOPICS.CREATED, payload);

    this.eventService
      .create({
        eventType: EVENT_TYPE_ENUM.NOTIFICATION_CREATED,
        metadata: {
          notificationId: params.notificationId,
          documentId: params.documentId,
          collaboratorId: params.collaboratorId,
        },
        from: actorUserId,
      })
      .catch((error) =>
        this.logger.error(
          `Error persistiendo el evento de la notificación ${params.notificationId}: ${error}`,
        ),
      );
  }
}
