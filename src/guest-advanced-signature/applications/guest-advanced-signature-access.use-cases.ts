import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, QueryFailedError } from 'typeorm';

import { EmailService } from 'src/common/email/email.service';
import { DocumentService } from 'src/document/document.service';
import { VerificationCodeService } from 'src/document/verification-code.service';
import { DOCUMENT_STATUS_ENUM } from 'src/document/enum/document-status.enum';
import { COLLABORATOR_STATUS_ENUM } from 'src/document/enum/collaborator-status.enum';
import { VERIFICATION_EVENT_ENUM } from 'src/document/enum/verification-event.enum';
import { GUEST_SIGNING_ACCESS_PURPOSE_ENUM } from 'src/document/enum/guest-signing-access-purpose.enum';
import { GuestSigningAccessService } from 'src/document/services/guest-signing-access.service';
import { GuestAdvancedInvitationNotFoundException } from 'src/document/exceptions/guest-signing-access.exceptions';
import { isSignerTurn } from 'src/document/utils/next-signer.util';

import { GuestAdvancedSignerService } from '../services/guest-advanced-signer.service';
import {
  GuestSigningTokenClaims,
  GuestSigningTokenService,
} from '../guest/guest-signing-token.service';

/** Vigencia del acceso de invitado: alcanza para revisar el documento y cargar la e.firma. */
export const GUEST_ADVANCED_ACCESS_TTL_SECONDS = 30 * 60;

/** Lo que ve un invitado del documento que se le pide firmar, una vez validado su acceso. */
export interface GuestAdvancedSigningDocument {
  documentId: string;
  fileName: string;
  documentStatus: DOCUMENT_STATUS_ENUM;
  signerStatus: COLLABORATOR_STATUS_ENUM;
  /** `true` si puede firmar ahora: documento pendiente, él pendiente y en su turno. */
  canSign: boolean;
  /**
   * SHA-256 del PDF vigente. El invitado lo devuelve al firmar: si cambió entre que lo leyó y que
   * firmó, la firma se rechaza.
   */
  documentHash: string | null;
  /** URL prefirmada del PDF vigente, para leerlo antes de firmar. */
  fileUrl: string;
  expiresIn: number;
}

/**
 * Acceso de un invitado sin cuenta a su Firma Avanzada: saber si la invitación lo admite, pedir el
 * código a su correo, canjearlo por un acceso temporal y ver el documento.
 *
 * El enlace del correo (documento + colaborador + correo, sin firma) sólo IDENTIFICA la invitación.
 * Lo que acredita al invitado es el código, que únicamente recibe quien controla ese correo; y lo
 * que lo autoriza a firmar es el acceso de `guest_signing_accesses` que se emite al canjearlo.
 */
@Injectable()
export class GuestAdvancedSignatureAccessUseCases {
  private readonly logger = new Logger(
    GuestAdvancedSignatureAccessUseCases.name,
  );

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly signers: GuestAdvancedSignerService,
    private readonly verificationCodeService: VerificationCodeService,
    private readonly accesses: GuestSigningAccessService,
    private readonly tokens: GuestSigningTokenService,
    private readonly emailService: EmailService,
    private readonly documentService: DocumentService,
  ) {}

  /**
   * Indica si la invitación admite Firma Avanzada sin cuenta. Lo usa la pantalla del enlace del
   * correo para ofrecer "Firmar sin cuenta" junto a "Tengo una cuenta".
   *
   * No lanza por una invitación que no aplica: responde `false`, sin decir por qué.
   *
   * @param documentId - Documento de la invitación.
   * @param collaboratorId - Colaborador de la invitación.
   * @param email - Correo del enlace, si lo trae (verificación adicional), o `null`: la invitación
   *   la identifica el colaborador.
   * @returns `{ guestAdvancedSignature: true }` si el colaborador es un firmante FIEL sin cuenta con
   *   ese correo.
   *
   * @example
   * ```ts
   * await guestAccess.checkInvitation('d-1', 'c-1', 'ana@correo.mx'); // { guestAdvancedSignature: true }
   * ```
   */
  async checkInvitation(
    documentId: string,
    collaboratorId: string,
    email: string | null,
  ): Promise<{ guestAdvancedSignature: boolean }> {
    try {
      await this.signers.resolveGuestSigner(documentId, collaboratorId, email);
      return { guestAdvancedSignature: true };
    } catch {
      return { guestAdvancedSignature: false };
    }
  }

  /**
   * Emite un código `GUEST_ADVANCED_SIGNATURE_ACCESS` y lo envía al correo de la invitación.
   *
   * Antes comprueba que el invitado pueda firmar ahora (documento pendiente, él pendiente y en su
   * turno, sin cuenta). El código va al correo GUARDADO del colaborador, no al de la petición.
   *
   * @param documentId - Documento de la invitación.
   * @param collaboratorId - Colaborador de la invitación.
   * @param email - Correo del enlace, si lo trae (verificación adicional), o `null`: la invitación
   *   la identifica el colaborador.
   * @param ipAddress - IP de la petición (queda en el código).
   * @returns Si el correo salió.
   *
   * @throws {NotFoundException} Si el documento no existe.
   * @throws {GuestAdvancedInvitationNotFoundException} Si la invitación no admite firma de invitado.
   * @throws {BadRequestException} Si el documento no está pendiente o el invitado ya respondió.
   * @throws {ForbiddenException} Si todavía no es su turno.
   *
   * @example
   * ```ts
   * await guestAccess.requestCode('d-1', 'c-1', 'ana@correo.mx', '10.0.0.1');
   * ```
   */
  async requestCode(
    documentId: string,
    collaboratorId: string,
    email: string | null,
    ipAddress: string | null,
  ): Promise<{ emailDelivered: boolean }> {
    const resolved = await this.signers.resolveGuestSigner(
      documentId,
      collaboratorId,
      email,
    );
    this.signers.assertCanRequestAccess(resolved);
    const { document, signer } = resolved;

    const verificationCode = await this.verificationCodeService.issue(
      documentId,
      signer.id,
      VERIFICATION_EVENT_ENUM.GUEST_ADVANCED_SIGNATURE_ACCESS,
      ipAddress ?? '0.0.0.0',
    );

    try {
      await this.emailService.sendVerificationCodeNotification(
        signer.email!,
        document.fileName,
        verificationCode.code,
      );
      return { emailDelivered: true };
    } catch (error) {
      this.logger.warn(
        `No se pudo enviar el código de Firma Avanzada de invitado del colaborador ${signer.id} (documento ${documentId}): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return { emailDelivered: false };
    }
  }

  /**
   * Canjea el código por un acceso temporal y su token.
   *
   * En una sola transacción: consume el código, revoca los accesos abiertos anteriores del mismo
   * colaborador y crea el nuevo. Si algo falla, el código sigue sin usar y no queda acceso.
   *
   * @param documentId - Documento de la invitación.
   * @param collaboratorId - Colaborador de la invitación.
   * @param email - Correo del enlace, si lo trae (verificación adicional), o `null`: la invitación
   *   la identifica el colaborador.
   * @param code - Código recibido por correo.
   * @param ipAddress - IP desde la que se valida (queda en el acceso).
   * @returns El token (su `jti` es el id del acceso) y cuándo vence.
   *
   * @throws {NotFoundException} Si el documento no existe.
   * @throws {GuestAdvancedInvitationNotFoundException} Si la invitación no admite firma de invitado.
   * @throws {BadRequestException} Si el documento ya no está pendiente, el invitado ya respondió, o
   *   no hay código pendiente, expiró, no coincide o ya se usó.
   * @throws {ForbiddenException} Si todavía no es su turno.
   * @throws {ConflictException} Si otra validación simultánea emitió un acceso primero.
   *
   * @example
   * ```ts
   * const { accessToken } = await guestAccess.verifyCode('d-1', 'c-1', 'ana@correo.mx', '123456', '10.0.0.1');
   * ```
   */
  async verifyCode(
    documentId: string,
    collaboratorId: string,
    email: string | null,
    code: string,
    ipAddress: string | null,
  ): Promise<{ accessToken: string; expiresAt: Date }> {
    const resolved = await this.signers.resolveGuestSigner(
      documentId,
      collaboratorId,
      email,
    );
    this.signers.assertCanRequestAccess(resolved);
    const { signer } = resolved;

    let access;
    try {
      access = await this.dataSource.transaction(async (manager) => {
        await this.verificationCodeService.verifyAndConsume(
          documentId,
          signer.id,
          code,
          VERIFICATION_EVENT_ENUM.GUEST_ADVANCED_SIGNATURE_ACCESS,
          manager,
        );

        return this.accesses.issue(manager, {
          documentId,
          collaboratorId: signer.id,
          email: signer.email!,
          purpose:
            GUEST_SIGNING_ACCESS_PURPOSE_ENUM.GUEST_ADVANCED_SIGNATURE_ACCESS,
          ipAddress,
          ttlSeconds: GUEST_ADVANCED_ACCESS_TTL_SECONDS,
        });
      });
    } catch (error) {
      if (
        error instanceof QueryFailedError &&
        (error as QueryFailedError & { code?: string }).code === '23505'
      ) {
        throw new ConflictException(
          'Ya se está validando otro código para esta firma. Inténtalo de nuevo.',
        );
      }
      throw error;
    }

    return this.tokens.issue(access);
  }

  /**
   * Lo que el invitado necesita ver antes de firmar: el documento, su hash, su estado y si puede
   * firmar.
   *
   * @param documentId - Documento de la invitación.
   * @param access - Lo que acreditó su token (el guard ya comprobó que el acceso está activo).
   * @returns Datos del documento y la URL prefirmada del PDF.
   *
   * @throws {NotFoundException} Si el documento no existe.
   * @throws {GuestAdvancedInvitationNotFoundException} Si la invitación ya no corresponde (p. ej.,
   *   se vinculó una cuenta) o el documento todavía no salió a firma.
   *
   * @example
   * ```ts
   * const view = await guestAccess.getDocument('d-1', claims);
   * ```
   */
  async getDocument(
    documentId: string,
    access: GuestSigningTokenClaims,
  ): Promise<GuestAdvancedSigningDocument> {
    const { document, signer, signers } = await this.signers.resolveGuestSigner(
      documentId,
      access.collaboratorId,
      null,
    );

    const notSentYet = [
      DOCUMENT_STATUS_ENUM.CREATED,
      DOCUMENT_STATUS_ENUM.PENDING_APPROVAL,
    ].includes(document.status);
    if (notSentYet) {
      throw new GuestAdvancedInvitationNotFoundException();
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
      documentHash: document.originalHash ?? null,
      fileUrl: file.secureUrl,
      expiresIn: file.expiresIn,
    };
  }
}
