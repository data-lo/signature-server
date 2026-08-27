import { Injectable, Logger } from '@nestjs/common';
import { KafkaProducerService } from './kafka-producer.service';
import {
  NOTIFICATION_KAFKA_TOPICS,
  NotificationEventPayload,
} from './notification-events.topics';
import { EventService } from 'src/event/event.service';
import { EVENT_TYPE_ENUM } from 'src/event/enums/event-type.enum';

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
  ) {}

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
