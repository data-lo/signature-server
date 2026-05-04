import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as sgMail from '@sendgrid/mail';
import {
  passwordResetTemplate,
  signatureNotificationTemplate,
  welcomeTemplate,
} from './email.templates';

@Injectable()
export class EmailService {
  constructor(private configService: ConfigService) {
    const apiKey = this.configService.get<string>('SENDGRID_API_KEY');
    if (!apiKey) {
      throw new Error('SENDGRID_API_KEY is not defined');
    }
    sgMail.setApiKey(apiKey);
  }

  /** Envía un correo genérico usando SendGrid. Usado internamente por los demás métodos. */
  async sendEmail(to: string, subject: string, html: string, from?: string): Promise<void> {
    const defaultFrom = this.configService.get<string>('SENDGRID_FROM_EMAIL') || 'noreply@yourdomain.com';

    const msg = {
      to,
      from: from || defaultFrom,
      subject,
      html,
    };

    try {
      await sgMail.send(msg);
    } catch (error) {
      console.error('Error sending email:', error);
      throw new Error('Failed to send email');
    }
  }

  /** Envía un correo de bienvenida al usuario recién registrado. */
  async sendWelcomeEmail(to: string, userName: string): Promise<void> {
    await this.sendEmail(to, 'Bienvenido a Signature Server', welcomeTemplate(userName));
  }

  /** Envía un correo con el enlace para restablecer la contraseña del usuario. */
  async sendPasswordResetEmail(to: string, resetToken: string): Promise<void> {
    const resetUrl = `${this.configService.get<string>('FRONTEND_URL')}/reset-password?token=${resetToken}`;
    await this.sendEmail(to, 'Restablecer contraseña', passwordResetTemplate(resetUrl));
  }

  /** Notifica al usuario que un documento está pendiente de su firma. */
  async sendSignatureNotification(to: string, documentName: string, signerName: string): Promise<void> {
    await this.sendEmail(to, 'Documento listo para firma', signatureNotificationTemplate(documentName, signerName));
  }
}
