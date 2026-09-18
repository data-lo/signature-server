import { Injectable, Logger } from '@nestjs/common';

import { EmailService } from 'src/common/email/email.service';
import { frontendBaseUrl } from 'src/common/utils/frontend-url.util';

import { OrganizationInvitationEventPayload } from '../organization-invitation.topics';

/**
 * `organization.member.invited`: despacha el correo de invitación vía SendGrid.
 *
 * A diferencia de los correos del ciclo de vida de documentos —inline y síncronos—, este envío
 * es asíncrono a propósito: `POST /api/v1/organizations/invite` responde en cuanto persiste la
 * invitación, sin esperar a SendGrid.
 */
@Injectable()
export class SendOrganizationInvitationEmailUseCase {
  private readonly logger = new Logger(
    SendOrganizationInvitationEmailUseCase.name,
  );

  constructor(private readonly emailService: EmailService) {}

  async execute(payload: OrganizationInvitationEventPayload): Promise<void> {
    this.logger.log(
      `Invitación a organización: ${payload.email} -> ${payload.organizationName} (${payload.organizationId}) @ ${payload.timestamp}`,
    );

    try {
      // Normalizada: leída cruda, una `FRONTEND_URL` con diagonal final generaba
      // `https://app.ejemplo.com//join?token=...` en el correo de invitación.
      //
      // Sólo el token: la organización la resuelve `/join` a partir de él, al consultar la
      // invitación. Llevarla también en la URL daba dos fuentes de la misma verdad, y un enlace
      // con `orgId` editado a mano apuntaba a una organización distinta de la invitada. Se
      // codifica por si algún día el token deja de ser un UUID.
      const joinUrl = `${frontendBaseUrl()}/join?token=${encodeURIComponent(payload.invitationToken)}`;

      await this.emailService.sendOrganizationInvitationNotification(
        payload.email,
        payload.organizationName,
        joinUrl,
      );
    } catch (error) {
      /**
       * Mismo criterio que el resto de los consumidores: un fallo nunca debe tumbar el proceso.
       * La invitación ya quedó persistida (PENDING) aunque el correo falle; el estado no se
       * pierde, sólo el usuario no recibe el aviso hasta que se reintente la invitación.
       */
      this.logger.error(
        `Error enviando el correo de invitación a ${payload.email}: ${error}`,
      );
    }
  }
}
