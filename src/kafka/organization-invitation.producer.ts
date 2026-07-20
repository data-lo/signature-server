import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { KafkaProducerService } from './kafka-producer.service';
import {
  ORGANIZATION_INVITATION_KAFKA_TOPICS,
  OrganizationInvitationEventPayload,
} from './organization-invitation.topics';

interface EmitInvitedParams {
  email: string;
  organizationId: string;
  organizationName: string;
  roleId: string;
  invitationToken: string;
}

/** Publica el evento de negocio de una invitación a organización recién creada. */
@Injectable()
export class OrganizationInvitationEventsProducer {
  constructor(private readonly kafkaProducer: KafkaProducerService) {}

  emitInvited(params: EmitInvitedParams) {
    const payload: OrganizationInvitationEventPayload = {
      eventId: randomUUID(),
      ...params,
      timestamp: new Date().toISOString(),
    };
    this.kafkaProducer.emit(
      ORGANIZATION_INVITATION_KAFKA_TOPICS.INVITED,
      payload,
    );
  }
}
