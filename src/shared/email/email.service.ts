// NestJS (framework)
import { ConfigService } from '@nestjs/config';
import { Injectable, InternalServerErrorException, Logger } from '@nestjs/common';

// Third-party libraries
import * as sgMail from '@sendgrid/mail';

// Internal modules
import { documentCancellationPendingTemplate, cancellationVerificationCodeTemplate, documentPendingTemplate, rejectionVerificationCodeTemplate, signatureRequestTemplate } from './templates/email.templates';
import { EmailType } from 'src/verification-code/enums/email-type.enum';
import { EmailSubject } from 'src/verification-code/enums/subject-type.enum';

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
  ): Promise<void> {
    const senderEmail = from ?? this.configService.get<string>('SENDGRID_FROM_EMAIL');

    const message: sgMail.MailDataRequired = {
      to,
      from: senderEmail,
      subject,
      html,
    };

    try {
      await sgMail.send(message);
      this.logger.log(`Email sent successfully to ${to} (${emailType})`);
    } catch (error) {
      this.logger.error(`Failed to send email to ${to} (${emailType})`, error);
      throw new InternalServerErrorException('Failed to send email');
    }
  }

  async sendVerificationCodeEmail(
    to: string,
    documentName: string,
    signerName: string,
    verificationCode: string
  ): Promise<void> {
    await this.sendEmail(
      to,
      EmailSubject.VERIFICATION,
      signatureRequestTemplate(documentName, signerName, verificationCode),
      EmailType.VERIFICATION,
    );
  }

  async sendDocumentPendingNotification(
    to: string,
    documentName: string,
    signerName: string,
  ): Promise<void> {
    await this.sendEmail(
      to,
      EmailSubject.DOCUMENT_PENDING,
      documentPendingTemplate(documentName, signerName),
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

  async sendCancellationVerificationCodeEmail(
    to: string,
    documentName: string,
    signerName: string,
    verificationCode: string,
  ): Promise<void> {
    await this.sendEmail(
      to,
      EmailSubject.CANCELLATION_CODE,
      cancellationVerificationCodeTemplate(documentName, signerName, verificationCode),
      EmailType.VERIFICATION,
    );
  }

  async sendRejectionVerificationCodeEmail(
    to: string,
    documentName: string,
    signerName: string,
    verificationCode: string,
  ): Promise<void> {
    await this.sendEmail(
      to,
      EmailSubject.REJECTION_CODE,
      rejectionVerificationCodeTemplate(documentName, signerName, verificationCode),
      EmailType.VERIFICATION,
    );
  }
}
