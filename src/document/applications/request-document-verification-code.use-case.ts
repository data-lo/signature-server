import { Injectable, Logger } from '@nestjs/common';

import { BaseResponse } from 'src/interfaces/api-response.dto';
import { EmailService } from 'src/shared/email/email.service';

import { VERIFICATION_EVENT_ENUM } from '../enum/verification-event.enum';
import { collaboratorEmail } from '../utils/collaborator-display.util';
import { VerificationCodeService } from '../verification-code.service';
import { DocumentService } from '../document.service';

/**
 * Emite y envía por correo el código de verificación con el que el firmante autenticado puede firmar
 * un documento con `requiresVerification=true` (`POST /document/:id/verification-codes`).
 *
 * El envío es best-effort y su resultado viaja en `emailDelivered`, para que la interfaz pueda
 * avisar y ofrecer el reenvío. Sin esa protección, una caída de SendGrid tumbaba la petición con un
 * 500 aunque el código ya estuviera emitido: la pantalla nunca mostraba el campo para capturarlo y
 * el firmante quedaba sin poder firmar *ni rechazar*. Es el mismo criterio que ya aplica el registro
 * de usuarios.
 */
@Injectable()
export class RequestDocumentVerificationCodeUseCase {
  private readonly logger = new Logger(
    RequestDocumentVerificationCodeUseCase.name,
  );

  constructor(
    private readonly verificationCodeService: VerificationCodeService,
    private readonly emailService: EmailService,
    private readonly documentService: DocumentService,
  ) {}

  async execute(
    documentId: string,
    currentUserId: string,
    ipAddress: string,
  ): Promise<BaseResponse<{ emailDelivered: boolean }>> {
    const document = await this.documentService.findOne(documentId);
    const myParticipant = await this.documentService.findMySignerCollaborator(
      documentId,
      currentUserId,
    );

    const verificationCode = await this.verificationCodeService.issue(
      documentId,
      myParticipant.id,
      VERIFICATION_EVENT_ENUM.SIGN_DOCUMENT,
      ipAddress,
    );

    const recipient = collaboratorEmail(myParticipant);
    let emailDelivered = true;

    try {
      await this.emailService.sendVerificationCodeNotification(
        recipient,
        document.fileName,
        verificationCode.code,
      );
    } catch (error) {
      emailDelivered = false;
      this.logger.warn(
        `No se pudo enviar el código de verificación de firma a ${recipient} (documento ${documentId}): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    return {
      success: true,
      message: emailDelivered
        ? 'Código de verificación enviado correctamente'
        : 'El código de verificación quedó emitido, pero no se pudo enviar el correo. Solicita un reenvío si no lo recibes.',
      data: { emailDelivered },
    };
  }
}
