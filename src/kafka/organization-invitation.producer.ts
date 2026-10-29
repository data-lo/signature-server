import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { KafkaProducerService } from './kafka-producer.service';
import {
  ORGANIZATION_INVITATION_KAFKA_TOPICS,
  OrganizationInvitationEventPayload,
} from './organization-invitation.topics';
import { EventService } from 'src/event/event.service';
import { EVENT_TYPE_ENUM } from 'src/event/enums/event-type.enum';

interface EmitInvitedParams {
  email: string;
  organizationId: string;
  organizationName: string;
  roleId: string;
  invitationToken: string;
  /** Solo para el registro de trazabilidad (EventModule) — no viaja en el payload de Kafka. */
  invitedBy: string;
}

/** Publica el evento de negocio de una invitación a organización recién creada. */
@Injectable()
export class OrganizationInvitationEventsProducer {
  private readonly logger = new Logger(
    OrganizationInvitationEventsProducer.name,
  );

  constructor(
    private readonly kafkaProducer: KafkaProducerService,
    private readonly eventService: EventService,
  ) {}

  emitInvited({ invitedBy, ...params }: EmitInvitedParams) {
    const payload: OrganizationInvitationEventPayload = {
      eventId: randomUUID(),
      ...params,
      timestamp: new Date().toISOString(),
    };
    this.kafkaProducer.emit(
      ORGANIZATION_INVITATION_KAFKA_TOPICS.INVITED,
      payload,
    );

    // Registro en Postgres para trazabilidad (EventModule), independiente de Kafka — ver mismo
    // criterio en DocumentEventsProducer. invitationToken NO se guarda en metadata: es una
    // credencial de un solo uso para consumar la invitación (ver OrganizationInvitationService),
    // ya vive en organization_invitations.token, y duplicarla en un log de propósito general
    // amplía innecesariamente su superficie de exposición.
    this.eventService
      .create({
        eventType: EVENT_TYPE_ENUM.ORGANIZATION_MEMBER_INVITED,
        metadata: {
          eventId: payload.eventId,
          email: payload.email,
          organizationId: payload.organizationId,
          organizationName: payload.organizationName,
          roleId: payload.roleId,
        },
        from: invitedBy,
      })
      .catch((error) =>
        this.logger.error(
          `Error persistiendo el evento de invitación a ${payload.email}: ${error}`,
        ),
      );
  }
}
