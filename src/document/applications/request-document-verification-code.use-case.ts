import { Injectable, Logger } from '@nestjs/common';

import { BaseResponse } from 'src/interfaces/api-response.dto';
import { EmailService } from 'src/shared/email/email.service';

import { VERIFICATION_EVENT_ENUM } from '../enum/verification-event.enum';
import { collaboratorEmail } from '../utils/collaborator-display.util';
import { VerificationCodeService } from '../verification-code.service';
import { DocumentService } from '../document.service';

/**
 * `POST /document/:id/verification-codes`: emite y envía por correo un código de verificación para que el firmante autenticado pueda
 * firmar un documento con `requiresVerification=true`.
 *
 * Bug corregido: el envío del correo se hacía sin protección después de persistir el código, así
 * que una caída del proveedor (SendGrid) tumbaba toda la petición con un 500 — el código ya
 * estaba emitido en la base, pero la pantalla de firma nunca llegaba a mostrar el campo para
 * capturarlo y el firmante quedaba sin poder firmar *ni rechazar*. El registro de usuarios ya
 * trataba este mismo fallo como no fatal (ver `UserService`: advierte y continúa); acá se
 * unifica ese criterio: el resultado del envío se reporta en `emailDelivered` para que la
 * interfaz pueda avisar y ofrecer el reenvío, en vez de dejar al usuario sin salida.
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
