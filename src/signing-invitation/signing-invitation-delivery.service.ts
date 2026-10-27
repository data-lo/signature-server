import { Injectable, Logger } from '@nestjs/common';

import { AuditService } from 'src/audit/audit.service';
import {
  AuditAction,
  AuditActorContext,
} from 'src/audit/schema/audit-document';
import { EmailService } from 'src/common/email/email.service';
import { CollaboratorEntity } from 'src/document/entities/collaborator.entity';
import { DocumentEntity } from 'src/document/entities/document.entity';
import {
  collaboratorDisplayName,
  collaboratorEmail,
} from 'src/document/utils/collaborator-display.util';

import { SigningInvitationService } from './signing-invitation.service';
import {
  INVITATION_ISSUE_COOLDOWN,
  INVITATION_ISSUE_DAILY,
  SigningRateLimitService,
} from './signing-rate-limit.service';

/** Lo que se necesita para emitir y enviar una invitación nueva. */
export interface DeliverSigningInvitationInput {
  document: DocumentEntity;
  /** Firmante, con `account.user` cargado si tiene cuenta (para su correo). */
  collaborator: CollaboratorEntity;
  /** Quién la pidió y con qué mecanismo: integración (`API_KEY`) o el firmante (`INVITATION_TOKEN`). */
  auditActor: AuditActorContext;
  ipAddress: string | null;
}

/** Resultado del envío. Nunca incluye el token ni el enlace. */
export interface DeliveredSigningInvitation {
  invitationId: string;
  expiresAt: Date;
  emailDelivered: boolean;
}

/**
 * Emite una invitación nueva para un firmante y se la manda a su correo: el reenvío de la API de
 * integración y la renovación pública de un enlace vencido son la misma operación.
 *
 * - Respeta los límites por colaborador (`INVITATION_ISSUE_COOLDOWN` y `INVITATION_ISSUE_DAILY`).
 * - La invitación nueva revoca la anterior (`SigningInvitationService.issue`).
 * - El enlace sólo va al correo guardado del colaborador: nunca se devuelve a quien lo pidió, así que
 *   pedir una renovación con un enlace viejo no le da a nadie más un enlace nuevo.
 * - Deja `SIGNING_INVITATION_ISSUED` en la auditoría del documento, con el actor.
 */
@Injectable()
export class SigningInvitationDeliveryService {
  private readonly logger = new Logger(SigningInvitationDeliveryService.name);

  constructor(
    private readonly invitations: SigningInvitationService,
    private readonly limits: SigningRateLimitService,
    private readonly emailService: EmailService,
    private readonly auditService: AuditService,
  ) {}

  /**
   * Emite, envía y audita una invitación nueva.
   *
   * @param input - Documento, firmante, actor e IP.
   * @returns La invitación emitida (sin token) y si el correo salió.
   *
   * @throws {SigningRateLimitException} (429) Si el firmante ya recibió demasiadas invitaciones.
   * @throws {QueryFailedError} (23505) Si otra petición emitió una a la vez.
   *
   * @example
   * ```ts
   * const { emailDelivered } = await delivery.deliver({ document, collaborator, auditActor, ipAddress });
   * ```
   */
  async deliver(
    input: DeliverSigningInvitationInput,
  ): Promise<DeliveredSigningInvitation> {
    const { document, collaborator } = input;
    await this.limits.consume(`collab:${collaborator.id}`, [
      INVITATION_ISSUE_COOLDOWN,
      INVITATION_ISSUE_DAILY,
    ]);

    const issued = await this.invitations.issue({
      documentId: document.id,
      collaboratorId: collaborator.id,
    });

    let emailDelivered = true;
    try {
      await this.emailService.sendDocumentInvitationNotification(
        collaboratorEmail(collaborator),
        collaboratorDisplayName(collaborator),
        document.fileName,
        issued.url,
      );
    } catch (error) {
      emailDelivered = false;
      // Sin el enlace ni el correo en el log: sólo ids.
      this.logger.warn(
        `No se pudo enviar la invitación ${issued.invitation.id} del colaborador ${collaborator.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    void this.auditService.create({
      documentId: document.id,
      operation: AuditAction.SIGNING_INVITATION_ISSUED,
      ipAddress: input.ipAddress ?? '0.0.0.0',
      actor: {
        ...input.auditActor,
        invitationId: issued.invitation.id,
        collaboratorId: collaborator.id,
      },
      result: emailDelivered ? 'SUCCESS' : 'FAILURE',
    });

    return {
      invitationId: issued.invitation.id,
      expiresAt: issued.invitation.expiresAt,
      emailDelivered,
    };
  }
}
