import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as sgMail from '@sendgrid/mail';

@Injectable()
export class EmailService {
  constructor(private configService: ConfigService) {
    const apiKey = this.configService.get<string>('SENDGRID_API_KEY');
    if (!apiKey) {
      throw new Error('SENDGRID_API_KEY is not defined');
    }
    sgMail.setApiKey(apiKey);
  }

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

  async sendWelcomeEmail(to: string, userName: string): Promise<void> {
    const subject = 'Bienvenido a Signature Server';
    const html = `
      <h1>Bienvenido, ${userName}!</h1>
      <p>Tu cuenta ha sido creada exitosamente en Signature Server.</p>
      <p>Puedes comenzar a usar nuestros servicios de firma digital.</p>
    `;

    await this.sendEmail(to, subject, html);
  }

  async sendPasswordResetEmail(to: string, resetToken: string): Promise<void> {
    const subject = 'Restablecer contraseña';
    const resetUrl = `${this.configService.get<string>('FRONTEND_URL')}/reset-password?token=${resetToken}`;
    const html = `
      <h1>Restablecer contraseña</h1>
      <p>Haz clic en el siguiente enlace para restablecer tu contraseña:</p>
      <a href="${resetUrl}">Restablecer contraseña</a>
      <p>Este enlace expirará en 1 hora.</p>
    `;

    await this.sendEmail(to, subject, html);
  }

  async sendSignatureNotification(to: string, documentName: string, signerName: string): Promise<void> {
    const subject = 'Documento listo para firma';
    const html = `
      <h1>Documento pendiente de firma</h1>
      <p>El documento "${documentName}" está listo para tu firma.</p>
      <p>Firmado por: ${signerName}</p>
      <p>Por favor, accede a tu cuenta para completar el proceso de firma.</p>
    `;

    await this.sendEmail(to, subject, html);
  }
}