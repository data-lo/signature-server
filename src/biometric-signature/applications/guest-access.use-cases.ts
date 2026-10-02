import { Injectable, Logger } from '@nestjs/common';

import { EmailService } from 'src/common/email/email.service';
import { DocumentService } from 'src/document/document.service';
import { VerificationCodeService } from 'src/document/verification-code.service';
import { DOCUMENT_STATUS_ENUM } from 'src/document/enum/document-status.enum';
import { COLLABORATOR_STATUS_ENUM } from 'src/document/enum/collaborator-status.enum';
import { VERIFICATION_EVENT_ENUM } from 'src/document/enum/verification-event.enum';
import { isSignerTurn } from 'src/document/utils/next-signer.util';
import { collaboratorEmail } from 'src/document/utils/collaborator-display.util';

import { GuestInvitationNotFoundException } from '../biometric-signature.exceptions';
import {
  GuestAccessClaims,
  GuestAccessTokenService,
} from '../guest/guest-access-token.service';
import { BiometricSignerService } from '../services/biometric-signer.service';

/** Lo que ve un invitado de la firma que le pidieron, una vez validado su acceso. */
export interface GuestSigningDocument {
  documentId: string;
  fileName: string;
  documentStatus: DOCUMENT_STATUS_ENUM;
  signerStatus: COLLABORATOR_STATUS_ENUM;
  /** `true` si puede iniciar la firma ahora: documento pendiente, él pendiente y en su turno. */
  canSign: boolean;
  /** URL prefirmada del PDF vigente, para leerlo antes de firmar. */
  fileUrl: string;
  expiresIn: number;
}

/**
 * Acceso de un invitado sin cuenta a su firma biométrica: saber si la invitación lo admite, pedir
 * el código a su correo, canjearlo por un token y ver el documento.
 *
 * El enlace del correo (documento + colaborador + correo, sin firma) sólo IDENTIFICA la invitación.
 * Lo que da acceso es el código, que únicamente recibe quien controla ese correo.
 */
@Injectable()
export class GuestBiometricAccessUseCases {
  private readonly logger = new Logger(GuestBiometricAccessUseCases.name);

  constructor(
    private readonly signers: BiometricSignerService,
    private readonly verificationCodeService: VerificationCodeService,
    private readonly emailService: EmailService,
    private readonly documentService: DocumentService,
    private readonly tokens: GuestAccessTokenService,
  ) {}

  /**
   * Indica si la invitación admite firma biométrica sin cuenta. Lo usa la pantalla del enlace del
   * correo para elegir entre el flujo de invitado y el inicio de sesión.
   *
   * No lanza por una invitación que no aplica: responde `false`, sin decir por qué.
   *
   * @param documentId - Documento de la invitación.
   * @param collaboratorId - Colaborador de la invitación.
   * @param email - Correo de la invitación.
   * @returns `{ guestBiometric: true }` si el colaborador es un firmante biométrico sin cuenta con
   *   ese correo.
   *
   * @example
   * ```ts
   * await guestAccess.checkInvitation('d-1', 'c-1', 'ana@correo.mx'); // { guestBiometric: true }
   * ```
   */
  async checkInvitation(
    documentId: string,
    collaboratorId: string,
    email: string,
  ): Promise<{ guestBiometric: boolean }> {
    try {
      await this.signers.resolveGuestSigner(documentId, collaboratorId, email);
      return { guestBiometric: true };
    } catch {
      return { guestBiometric: false };
    }
  }

  /**
   * Emite un código de acceso y lo envía al correo de la invitación.
   *
   * El código va al correo GUARDADO del colaborador, no al que viene en la petición: aunque alguien
   * conozca el enlace, el código sólo llega a quien controla ese buzón.
   *
   * @param documentId - Documento de la invitación.
   * @param collaboratorId - Colaborador de la invitación.
   * @param email - Correo de la invitación.
   * @param ipAddress - IP de la petición (queda en el código).
   * @returns Si el correo salió.
   *
   * @throws {NotFoundException} Si el documento no existe.
   * @throws {GuestInvitationNotFoundException} Si la invitación no admite firma de invitado.
   *
   * @example
   * ```ts
   * await guestAccess.requestCode('d-1', 'c-1', 'ana@correo.mx', '10.0.0.1');
   * ```
   */
  async requestCode(
    documentId: string,
    collaboratorId: string,
    email: string,
    ipAddress: string,
  ): Promise<{ emailDelivered: boolean }> {
    const { document, signer } = await this.signers.resolveGuestSigner(
      documentId,
      collaboratorId,
      email,
    );

    const verificationCode = await this.verificationCodeService.issue(
      documentId,
      signer.id,
      VERIFICATION_EVENT_ENUM.GUEST_BIOMETRIC_ACCESS,
      ipAddress ?? '0.0.0.0',
    );

    try {
      await this.emailService.sendVerificationCodeNotification(
        collaboratorEmail(signer),
        document.fileName,
        verificationCode.code,
      );
      return { emailDelivered: true };
    } catch (error) {
      this.logger.warn(
        `No se pudo enviar el código de acceso de invitado del colaborador ${signer.id} (documento ${documentId}): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return { emailDelivered: false };
    }
  }

  /**
   * Canjea el código por un token de acceso de corta vida atado a documento, colaborador y correo.
   *
   * @param documentId - Documento de la invitación.
   * @param collaboratorId - Colaborador de la invitación.
   * @param email - Correo de la invitación.
   * @param code - Código recibido por correo.
   * @returns El token y cuándo vence.
   *
   * @throws {NotFoundException} Si el documento no existe.
   * @throws {GuestInvitationNotFoundException} Si la invitación no admite firma de invitado.
   * @throws {BadRequestException} Si no hay código pendiente, expiró o no coincide.
   *
   * @example
   * ```ts
   * const { accessToken } = await guestAccess.verifyCode('d-1', 'c-1', 'ana@correo.mx', '123456');
   * ```
   */
  async verifyCode(
    documentId: string,
    collaboratorId: string,
    email: string,
    code: string,
  ): Promise<{ accessToken: string; expiresAt: Date }> {
    const { signer } = await this.signers.resolveGuestSigner(
      documentId,
      collaboratorId,
      email,
    );

    await this.verificationCodeService.verifyAndConsume(
      documentId,
      signer.id,
      code,
      VERIFICATION_EVENT_ENUM.GUEST_BIOMETRIC_ACCESS,
    );

    return this.tokens.issue({
      documentId,
      collaboratorId: signer.id,
      email: collaboratorEmail(signer),
    });
  }

  /**
   * Lo que el invitado necesita ver antes de firmar: el documento, su estado y si puede firmar.
   *
   * @param documentId - Documento de la invitación.
   * @param access - Lo que acreditó su token.
   * @returns Datos del documento y la URL prefirmada del PDF.
   *
   * @throws {NotFoundException} Si el documento no existe.
   * @throws {GuestInvitationNotFoundException} Si la invitación ya no corresponde.
   *
   * @example
   * ```ts
   * const view = await guestAccess.getDocument('d-1', claims);
   * ```
   */
  async getDocument(
    documentId: string,
    access: GuestAccessClaims,
  ): Promise<GuestSigningDocument> {
    const { document, signer, signers } = await this.signers.resolveGuestSigner(
      documentId,
      access.collaboratorId,
      access.email,
    );

    const notSentYet = [
      DOCUMENT_STATUS_ENUM.CREATED,
      DOCUMENT_STATUS_ENUM.PENDING_APPROVAL,
    ].includes(document.status);
    if (notSentYet) {
      // Un documento que todavía no se envió a firma no se le muestra a ningún invitado.
      throw new GuestInvitationNotFoundException();
    }

    const file = await this.documentService.getDocumentMinioURL(documentId);

    return {
      documentId,
      fileName: document.fileName,
      documentStatus: document.status,
      signerStatus: signer.status,
      canSign:
        document.status === DOCUMENT_STATUS_ENUM.PENDING_SIGNATURE &&
        signer.status === COLLABORATOR_STATUS_ENUM.PENDING &&
        isSignerTurn(signer, signers, document.isSequential),
      fileUrl: file.secureUrl,
      expiresIn: file.expiresIn,
    };
  }
}
