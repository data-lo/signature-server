import { Controller, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventPattern, Payload } from '@nestjs/microservices';
import {
  ORGANIZATION_INVITATION_KAFKA_TOPICS,
  OrganizationInvitationEventPayload,
} from './organization-invitation.topics';
import { EmailService } from 'src/shared/email/email.service';

/**
 * Worker que consume `organization.member.invited` (ver OrganizationInvitationEventsProducer)
 * y despacha el correo de invitación vía SendGrid — a diferencia de los correos del ciclo de
 * vida de documentos (inline/síncronos en document.service.ts), este envío es intencionalmente
 * asíncrono: `POST /api/v1/organizations/invite` responde en cuanto persiste la invitación,
 * sin esperar a SendGrid.
 */
@Controller()
export class OrganizationInvitationEventsConsumer {
  private readonly logger = new Logger(
    OrganizationInvitationEventsConsumer.name,
  );

  constructor(
    private readonly emailService: EmailService,
    private readonly configService: ConfigService,
  ) {}

  @EventPattern(ORGANIZATION_INVITATION_KAFKA_TOPICS.INVITED)
  async handleInvited(@Payload() payload: OrganizationInvitationEventPayload) {
    this.logger.log(
      `Invitación a organización: ${payload.email} -> ${payload.organizationName} (${payload.organizationId}) @ ${payload.timestamp}`,
    );

    try {
      const frontendUrl =
        this.configService.get<string>('FRONTEND_URL') ??
        'http://localhost:3001';
      const joinUrl = `${frontendUrl}/join?token=${payload.invitationToken}&orgId=${payload.organizationId}`;

      await this.emailService.sendOrganizationInvitationNotification(
        payload.email,
        payload.organizationName,
        joinUrl,
      );
    } catch (error) {
      // Igual criterio que DocumentEventsConsumer: un fallo del consumer nunca debe tumbar el
      // proceso — la invitación ya quedó persistida (PENDING) aunque el correo falle; el estado
      // no se pierde, solo el usuario no recibe el aviso hasta reintentar la invitación.
      this.logger.error(
        `Error enviando el correo de invitación a ${payload.email}: ${error}`,
      );
    }
  }
}
