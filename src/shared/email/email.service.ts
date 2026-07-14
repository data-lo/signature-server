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
  documentPendingTemplate,
  documentRejectedTemplate,
  documentSignedTemplate,
} from './templates/email.templates';
import { EmailType } from './enums/email-type.enum';
import { EmailSubject } from './enums/subject-type.enum';

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);

  constructor(private readonly configService: ConfigService) {
    const apiKey = this.configService.get<string>('SENDGRID_API_KEY');

    if (!apiKey) {
      throw new InternalServerErrorException('SENDGRID_API_KEY is not defined');
    }

    sgMail.setApiKey(apiKey);
    this.logger.log('SendGrid initialized');
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
    from?: string,
    attachments?: sgMail.MailDataRequired['attachments'],
  ): Promise<void> {
    const senderEmail =
      from ?? this.configService.get<string>('SENDGRID_FROM_EMAIL');

    const message: sgMail.MailDataRequired = {
      to,
      from: senderEmail,
      subject,
      html,
      ...(attachments && { attachments }),
    };

    try {
      await sgMail.send(message);
      this.logger.log(`Email sent successfully to ${to} (${emailType})`);
    } catch (error) {
      this.logger.error(`Failed to send email to ${to} (${emailType})`, error);
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
}
