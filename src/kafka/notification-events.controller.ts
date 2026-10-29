import { Controller } from '@nestjs/common';
import { EventPattern, Payload } from '@nestjs/microservices';

import {
  NOTIFICATION_KAFKA_TOPICS,
  NotificationEventPayload,
} from './notification-events.topics';
import { SendPendingSignatureNotificationUseCase } from './applications/send-pending-signature-notification.use-case';

/** Adaptador de Kafka: delega en el caso de uso que decide y manda el correo. */
@Controller()
export class NotificationEventsConsumer {
  constructor(
    private readonly sendPendingSignatureNotification: SendPendingSignatureNotificationUseCase,
  ) {}

  @EventPattern(NOTIFICATION_KAFKA_TOPICS.CREATED)
  async handleCreated(@Payload() payload: NotificationEventPayload) {
    await this.sendPendingSignatureNotification.execute(payload);
  }
}
