import { Injectable } from '@nestjs/common';

import { AuthorizationContext } from 'src/authorization/interfaces/authorization-context.interface';
import { COLLABORATOR_STATUS_ENUM } from 'src/document/enum/collaborator-status.enum';
import { DOCUMENT_STATUS_ENUM } from 'src/document/enum/document-status.enum';

import { BiometricSignatureSession } from '../interfaces/biometric-signature-session.interface';
import { GuestAccessClaims } from '../guest/guest-access-token.service';
import { BiometricSignatureAttemptService } from '../services/biometric-signature-attempt.service';
import {
  BiometricSignerService,
  ResolvedBiometricSigner,
} from '../services/biometric-signer.service';

/**
 * Estado de la firma biométrica de un firmante: lo que sondea la pantalla mientras hace la prueba
 * en Didit. Sólo lee; el resultado lo decide el webhook. Nunca expone el veredicto biométrico.
 */
@Injectable()
export class GetBiometricSignatureStatusUseCase {
  constructor(
    private readonly signers: BiometricSignerService,
    private readonly attempts: BiometricSignatureAttemptService,
  ) {}

  /**
   * Estado para el firmante autenticado.
   *
   * @param documentId - Documento consultado.
   * @param userId - Usuario autenticado.
   * @param authorization - Contexto de `PermissionsGuard` para `DOCUMENT + SIGN`.
   * @returns La sesión del último intento, o `null` si nunca inició uno.
   *
   * @throws {NotFoundException} Si el documento no existe.
   * @throws {ForbiddenException} Si no es firmante o no tiene `DOCUMENT.SIGN_SELF`.
   *
   * @example
   * ```ts
   * await getStatus.forAccount('d-1', 'u-1', auth);
   * ```
   */
  async forAccount(
    documentId: string,
    userId: string,
    authorization: AuthorizationContext,
  ): Promise<BiometricSignatureSession | null> {
    return this.present(
      await this.signers.resolveAccountSigner(
        documentId,
        userId,
        authorization,
      ),
    );
  }

  /**
   * Estado para el invitado que validó su código.
   *
   * @param documentId - Documento consultado.
   * @param access - Lo que acreditó su token de invitado.
   * @returns La sesión del último intento, o `null` si nunca inició uno.
   *
   * @throws {NotFoundException} Si el documento no existe.
   * @throws {GuestInvitationNotFoundException} Si la invitación ya no corresponde.
   *
   * @example
   * ```ts
   * await getStatus.forGuest('d-1', claims);
   * ```
   */
  async forGuest(
    documentId: string,
    access: GuestAccessClaims,
  ): Promise<BiometricSignatureSession | null> {
    return this.present(
      await this.signers.resolveGuestSigner(
        documentId,
        access.collaboratorId,
        access.email,
      ),
    );
  }

  /**
   * Arma el estado a partir del último intento del firmante.
   *
   * @param resolved - Firmante resuelto con su documento.
   * @returns La sesión del último intento, o `null`.
   *
   * @example
   * ```ts
   * return this.present(resolved);
   * ```
   */
  private async present({
    document,
    signer,
  }: ResolvedBiometricSigner): Promise<BiometricSignatureSession | null> {
    const latest = await this.attempts.findLatest(signer.id);
    if (!latest) {
      return null;
    }

    const signatureCompleted =
      signer.status === COLLABORATOR_STATUS_ENUM.SIGNED;

    return this.attempts.toSession(latest, {
      reused: true,
      signatureCompleted,
      // Registrada esta firma, si el documento ya no está pendiente es que era la última.
      documentCompleted:
        signatureCompleted &&
        document.status !== DOCUMENT_STATUS_ENUM.PENDING_SIGNATURE,
    });
  }
}
