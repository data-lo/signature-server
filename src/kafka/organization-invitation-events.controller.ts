import { Controller } from '@nestjs/common';
import { EventPattern, Payload } from '@nestjs/microservices';

import {
  ORGANIZATION_INVITATION_KAFKA_TOPICS,
  OrganizationInvitationEventPayload,
} from './organization-invitation.topics';
import { SendOrganizationInvitationEmailUseCase } from './applications/send-organization-invitation-email.use-case';

/** Adaptador de Kafka: delega en el caso de uso que manda el correo de invitación. */
@Controller()
export class OrganizationInvitationEventsConsumer {
  constructor(
    private readonly sendOrganizationInvitationEmail: SendOrganizationInvitationEmailUseCase,
  ) {}

  @EventPattern(ORGANIZATION_INVITATION_KAFKA_TOPICS.INVITED)
  async handleInvited(@Payload() payload: OrganizationInvitationEventPayload) {
    await this.sendOrganizationInvitationEmail.execute(payload);
  }
}
