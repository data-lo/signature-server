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
  documentCancellationPendingTemplate,
  documentCancelledTemplate,
  documentCompletedForCreatorTemplate,
  documentInvitationTemplate,
  documentPendingTemplate,
  documentRejectedTemplate,
  documentSignedTemplate,
  organizationInvitationTemplate,
  passwordResetOtpTemplate,
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
}
