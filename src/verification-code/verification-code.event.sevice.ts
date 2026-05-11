import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { EmailService } from 'src/shared/email/email.service';
import { VerificationCodeEmailPayload } from './interfaces/verification-code-email.payload';

@Injectable()
export class VerificationCodeEventService {
  private readonly logger = new Logger(VerificationCodeEventService.name);

  constructor(private readonly emailService: EmailService) {}

  @OnEvent('send.verification.code.email', { async: true })
  async sendVerificationCodeEmailEvent(payload: VerificationCodeEmailPayload) {
    this.logger.log(`[send.verification.code.email] Enviando código de verificación | to: ${payload.to} | signerName: ${payload.signerName}`);

    try {
      await this.emailService.sendVerificationCodeEmail(
        payload.to,
        payload.documentName,
        payload.signerName,
        payload.code,
      );
      this.logger.log(`[send.verification.code.email] Correo enviado correctamente | to: ${payload.to}`);
    } catch (error) {
      this.logger.error(
        `[send.verification.code.email] Error al enviar el correo | to: ${payload.to} | mensaje: ${error}`,
        error,
      );
    }
  }

  @OnEvent('send.cancellation.code.email', { async: true })
  async sendCancellationCodeEmailEvent(payload: VerificationCodeEmailPayload) {
    this.logger.log(`[send.cancellation.code.email] Enviando código de cancelación | to: ${payload.to} | signerName: ${payload.signerName}`);

    try {
      await this.emailService.sendCancellationVerificationCodeEmail(
        payload.to,
        payload.documentName,
        payload.signerName,
        payload.code,
      );
      this.logger.log(`[send.cancellation.code.email] Correo enviado correctamente | to: ${payload.to}`);
    } catch (error) {
      this.logger.error(
        `[send.cancellation.code.email] Error al enviar el correo | to: ${payload.to} | mensaje: ${error}`,
        error,
      );
    }
  }

  @OnEvent('send.rejection.code.email', { async: true })
  async sendRejectionCodeEmailEvent(payload: VerificationCodeEmailPayload) {
    this.logger.log(`[send.rejection.code.email] Enviando código de rechazo | to: ${payload.to} | signerName: ${payload.signerName}`);

    try {
      await this.emailService.sendRejectionVerificationCodeEmail(
        payload.to,
        payload.documentName,
        payload.signerName,
        payload.code,
      );
      this.logger.log(`[send.rejection.code.email] Correo enviado correctamente | to: ${payload.to}`);
    } catch (error) {
      this.logger.error(
        `[send.rejection.code.email] Error al enviar el correo | to: ${payload.to} | mensaje: ${error}`,
        error,
      );
    }
  }
}