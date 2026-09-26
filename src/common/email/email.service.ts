// NestJS (framework)
import { ConfigService } from '@nestjs/config';
import {
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';

// Third-party libraries
import * as sgMail from '@sendgrid/mail';

// Internal modules
import {
  documentApprovalRequestedTemplate,
  documentCancellationPendingTemplate,
  documentCancelledTemplate,
  documentCompletedForCreatorTemplate,
  documentInvitationTemplate,
  documentPendingTemplate,
  documentRejectedTemplate,
  documentSignedTemplate,
  documentWitnessAddedTemplate,
  documentRejectedToWitnessTemplate,
  organizationInvitationTemplate,
  organizationMemberJoinedTemplate,
  passwordResetOtpTemplate,
  registrationOtpTemplate,
  verificationCodeTemplate,
} from './templates/email.templates';
import { EmailType } from './enums/email-type.enum';
import { EmailSubject } from './enums/subject-type.enum';

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);
  private readonly defaultFromEmail: string;

  constructor(private readonly configService: ConfigService) {
    const apiKey = this.configService.get<string>('SENDGRID_API_KEY');
    const fromEmail = this.configService.get<string>('SENDGRID_FROM_EMAIL');

    if (!apiKey) {
      throw new InternalServerErrorException('SENDGRID_API_KEY is not defined');
    }

    if (!fromEmail) {
      throw new InternalServerErrorException(
        'SENDGRID_FROM_EMAIL is not defined',
      );
    }

    this.defaultFromEmail = fromEmail;
    sgMail.setApiKey(apiKey);
    this.logger.log(
      `SendGrid initialized with sender: ${this.defaultFromEmail}`,
    );
  }

  /**
   * Envía un correo electrónico mediante SendGrid.
   * Método base utilizado internamente por los demás métodos de notificación.
   */
  async sendEmail(
    to: string,
    subject: string,
    html: string,
    emailType: EmailType,
    replyTo?: string,
    attachments?: sgMail.MailDataRequired['attachments'],
  ): Promise<void> {
    // Siempre usaremos la dirección oficial/verificada de la empresa como remitente (from)
    const message: sgMail.MailDataRequired = {
      to,
      from: this.defaultFromEmail,
      subject,
      html,
      ...(replyTo && { replyTo }),
      ...(attachments && { attachments }),
    };

    try {
      await sgMail.send(message);
      this.logger.log(`Email sent successfully to ${to} (${emailType})`);
    } catch (error: any) {
      this.logger.error(
        `Failed to send email to ${to} (${emailType}): ${error?.response?.body ? JSON.stringify(error.response.body) : error?.message || error}`,
      );
      throw new InternalServerErrorException('Failed to send email');
    }
  }

  /** Notifica al firmante en turno que se solicita su firma, con links a la pantalla de firma y al listado de documentos. */
  async sendDocumentPendingNotification(
    to: string,
    signerName: string,
    creatorEmail: string,
    documentName: string,
    documentUrl: string,
    allDocumentsUrl: string,
  ): Promise<void> {
    await this.sendEmail(
      to,
      EmailSubject.DOCUMENT_PENDING,
      documentPendingTemplate(
        signerName,
        creatorEmail,
        documentName,
        documentUrl,
        allDocumentsUrl,
      ),
      EmailType.NOTIFICATION,
      creatorEmail, // 👈 Pasamos el correo del creador como replyTo
    );
  }

  /** Envía el PDF firmado como comprobante a un participante (firmante o espectador) una vez completado el proceso. */
  async sendDocumentSignedNotification(
    to: string,
    participantName: string,
    documentName: string,
    signedFileBuffer: Buffer,
  ): Promise<void> {
    await this.sendEmail(
      to,
      EmailSubject.DOCUMENT_SIGNED,
      documentSignedTemplate(participantName, documentName),
      EmailType.NOTIFICATION,
      undefined,
      [
        {
          content: signedFileBuffer.toString('base64'),
          filename: documentName,
          type: 'application/pdf',
          disposition: 'attachment',
        },
      ],
    );
  }

  /**
   * Notifica a quien creó el documento (y asignó a los firmantes) que todos ya firmaron,
   * incluyendo la lista de firmantes y el PDF final como comprobante — distinto del correo que
   * recibe cada participante (sendDocumentSignedNotification), porque el creador no siempre es
   * también un participante.
   */
  async sendDocumentCompletedToCreatorNotification(
    to: string,
    creatorName: string,
    documentName: string,
    signerNames: string[],
    signedFileBuffer: Buffer,
  ): Promise<void> {
    await this.sendEmail(
      to,
      EmailSubject.DOCUMENT_SIGNED,
      documentCompletedForCreatorTemplate(
        creatorName,
        documentName,
        signerNames,
      ),
      EmailType.NOTIFICATION,
      undefined,
      [
        {
          content: signedFileBuffer.toString('base64'),
          filename: documentName,
          type: 'application/pdf',
          disposition: 'attachment',
        },
      ],
    );
  }

  /** Notifica al creador del documento que un firmante lo rechazó, incluyendo el motivo. */
  async sendDocumentRejectedNotification(
    to: string,
    creatorName: string,
    rejecterName: string,
    documentName: string,
    reason: string,
  ): Promise<void> {
    await this.sendEmail(
      to,
      EmailSubject.DOCUMENT_REJECTED,
      documentRejectedTemplate(creatorName, rejecterName, documentName, reason),
      EmailType.NOTIFICATION,
    );
  }

  /**
   * Notifica a un testigo que un firmante rechazó el documento, con el motivo.
   *
   * @param to - Correo del testigo.
   * @param witnessName - Nombre con el que se le saluda.
   * @param rejecterName - Quién rechazó el documento.
   * @param documentName - Nombre del documento.
   * @param reason - Motivo del rechazo.
   * @returns Nada.
   *
   * @throws {InternalServerErrorException} Si el proveedor de correo rechaza el envío.
   *
   * @example
   * ```ts
   * await emailService.sendDocumentRejectedToWitnessNotification('ana@x.com', 'Ana', 'Juan Pérez', 'contrato.pdf', 'Faltan cláusulas');
   * ```
   */
  async sendDocumentRejectedToWitnessNotification(
    to: string,
    witnessName: string,
    rejecterName: string,
    documentName: string,
    reason: string,
  ): Promise<void> {
    await this.sendEmail(
      to,
      EmailSubject.DOCUMENT_REJECTED,
      documentRejectedToWitnessTemplate(
        witnessName,
        rejecterName,
        documentName,
        reason,
      ),
      EmailType.NOTIFICATION,
    );
  }

  async sendDocumentCancellationPendingNotification(
    to: string,
    documentName: string,
    signerName: string,
  ): Promise<void> {
    await this.sendEmail(
      to,
      EmailSubject.CANCELLATION_PENDING,
      documentCancellationPendingTemplate(documentName, signerName),
      EmailType.NOTIFICATION,
    );
  }

  /** Notifica a un participante que el documento fue cancelado y ya no requiere ninguna acción. */
  async sendDocumentCancelledNotification(
    to: string,
    participantName: string,
    documentName: string,
  ): Promise<void> {
    await this.sendEmail(
      to,
      EmailSubject.DOCUMENT_CANCELLED,
      documentCancelledTemplate(participantName, documentName),
      EmailType.NOTIFICATION,
    );
  }

  /** Envía el código de verificación de un firmante para un documento con requiresVerification=true (ver Fase 7 del plan de migración ER-V2). */
  async sendVerificationCodeNotification(
    to: string,
    documentName: string,
    code: string,
  ): Promise<void> {
    await this.sendEmail(
      to,
      EmailSubject.VERIFICATION_CODE,
      verificationCodeTemplate(documentName, code),
      EmailType.NOTIFICATION,
    );
  }

  /** Envía el código de verificación del flujo de recuperación de contraseña (ver historia "Recuperación de Contraseña mediante Código de Verificación OTP"). */
  async sendPasswordResetOtpNotification(
    to: string,
    code: string,
  ): Promise<void> {
    await this.sendEmail(
      to,
      EmailSubject.PASSWORD_RESET_OTP,
      passwordResetOtpTemplate(code),
      EmailType.NOTIFICATION,
    );
  }

  /** Envía el código de verificación de correo del flujo de pre-registro/OTP (ver historia "Auth: Flujo de Pre-registro, Verificación OTP y Control por CURP"). */
  async sendRegistrationOtpNotification(
    to: string,
    code: string,
  ): Promise<void> {
    await this.sendEmail(
      to,
      EmailSubject.REGISTRATION_OTP,
      registrationOtpTemplate(code),
      EmailType.NOTIFICATION,
    );
  }

  /**
   * Invita por correo a un colaborador de Firma Digital Simple en un documento sin orden
   * (isSequential=false) a registrarse/iniciar sesión y firmar (ver historia "Notificación por
   * Email para Firma Simple y Vinculación de Cuenta"). `accessUrl` apunta a
   * /access-document?docId=...&collabId=...&email=..., que el frontend usa para guardar el
   * contexto en localStorage y guiar al usuario a /login o /register.
   */
  async sendDocumentInvitationNotification(
    to: string,
    signerName: string,
    documentName: string,
    accessUrl: string,
  ): Promise<void> {
    await this.sendEmail(
      to,
      EmailSubject.DOCUMENT_INVITATION,
      documentInvitationTemplate(signerName, documentName, accessUrl),
      EmailType.NOTIFICATION,
    );
  }

  /**
   * Avisa a un colaborador WITNESS (testigo) que lo agregaron a un documento (historia "Actualizar estatus
   * de watchers a NOTIFIED..."). `creatorEmail` va como replyTo, igual que
   * `sendDocumentPendingNotification`: quien responda preguntando de qué documento se trata llega
   * directo a quien lo creó.
   */
  async sendDocumentWitnessAddedNotification(
    to: string,
    witnessName: string,
    documentName: string,
    creatorName: string,
    creatorEmail: string,
    accessUrl: string,
  ): Promise<void> {
    await this.sendEmail(
      to,
      EmailSubject.DOCUMENT_WITNESS_ADDED,
      documentWitnessAddedTemplate(
        witnessName,
        documentName,
        creatorName,
        accessUrl,
      ),
      EmailType.NOTIFICATION,
      creatorEmail,
    );
  }

  /**
   * Avisa al aprobador asignado que tiene un documento pendiente de aprobación.
   *
   * `creatorEmail` va como replyTo, igual que en el aviso a firmantes y testigos: quien responda
   * preguntando por el documento llega directo a quien pidió la aprobación.
   *
   * @param to - Correo del aprobador.
   * @param reviewerName - Nombre del aprobador, para el saludo.
   * @param documentName - Nombre del documento que espera aprobación.
   * @param creatorName - Nombre de quien creó el documento.
   * @param creatorEmail - Correo de quien creó el documento; se usa como replyTo.
   * @param accessUrl - Enlace de acceso al documento (ver `buildDocumentAccessUrl`).
   * @returns Nada, una vez que SendGrid aceptó el mensaje.
   *
   * @throws {InternalServerErrorException} Si SendGrid rechaza o no recibe el envío.
   *
   * @example
   * ```ts
   * await emailService.sendDocumentApprovalRequestedNotification(
   *   'ana@acme.mx',
   *   'Ana López',
   *   'contrato.pdf',
   *   'Sara Ramírez',
   *   'sara@acme.mx',
   *   accessUrl,
   * );
   * ```
   */
  async sendDocumentApprovalRequestedNotification(
    to: string,
    reviewerName: string,
    documentName: string,
    creatorName: string,
    creatorEmail: string,
    accessUrl: string,
  ): Promise<void> {
    await this.sendEmail(
      to,
      EmailSubject.DOCUMENT_APPROVAL_REQUESTED,
      documentApprovalRequestedTemplate(
        reviewerName,
        documentName,
        creatorName,
        accessUrl,
      ),
      EmailType.NOTIFICATION,
      creatorEmail,
    );
  }

  /** Notifica a un correo invitado a una organización, con el enlace a /join (ver OrganizationInvitationEventsConsumer). */
  async sendOrganizationInvitationNotification(
    to: string,
    organizationName: string,
    joinUrl: string,
  ): Promise<void> {
    await this.sendEmail(
      to,
      EmailSubject.ORGANIZATION_INVITATION,
      organizationInvitationTemplate(organizationName, joinUrl),
      EmailType.NOTIFICATION,
    );
  }

  /**
   * Avisa a un propietario o administrador de que alguien se incorporó a su organización.
   *
   * Sin `replyTo`: el destinatario no tiene que responderle a nadie —es un aviso, no una
   * solicitud—, y poner el correo del nuevo miembro invitaría a contestarle al buzón equivocado.
   *
   * @param to - Correo del propietario o administrador que recibe el aviso.
   * @param recipientName - Nombre de quien recibe el aviso, para encabezar el mensaje.
   * @param memberFullName - Nombre completo de quien se acaba de unir.
   * @param memberEmail - Correo de quien se acaba de unir.
   * @param organizationName - Nombre de visualización de la organización.
   * @param roleName - Rol con el que quedó la nueva membresía.
   * @param membersUrl - Enlace a la sección de miembros de la organización.
   * @returns Nada.
   *
   * @throws {InternalServerErrorException} Si SendGrid rechaza el envío.
   *
   * @example
   * ```ts
   * await emailService.sendOrganizationMemberJoinedNotification(
   *   'owner@empresa.com',
   *   'Ana',
   *   'Luis Pérez',
   *   'luis@empresa.com',
   *   'Empresa S.A.',
   *   'MEMBER',
   *   buildOrganizationMembersUrl('org-1'),
   * );
   * ```
   */
  async sendOrganizationMemberJoinedNotification(
    to: string,
    recipientName: string,
    memberFullName: string,
    memberEmail: string,
    organizationName: string,
    roleName: string,
    membersUrl: string,
  ): Promise<void> {
    await this.sendEmail(
      to,
      EmailSubject.ORGANIZATION_MEMBER_JOINED,
      organizationMemberJoinedTemplate(
        recipientName,
        memberFullName,
        memberEmail,
        organizationName,
        roleName,
        membersUrl,
      ),
      EmailType.NOTIFICATION,
    );
  }
}
