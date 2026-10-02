import { ForbiddenException, Injectable } from '@nestjs/common';

import { AuthorizationContext } from 'src/authorization/interfaces/authorization-context.interface';

import { DocumentService } from '../../document.service';
import { DocumentAuthorizationPolicy } from '../../policies/document-authorization.policy';
import { COLLABORATOR_STATUS_ENUM } from '../../enum/collaborator-status.enum';
import { DOCUMENT_STATUS_ENUM } from '../../enum/document-status.enum';
import { BiometricSignatureSession } from '../interfaces/biometric-signature-session.interface';
import { BiometricSignatureAttemptService } from '../services/biometric-signature-attempt.service';

/**
 * Estado de la firma biométrica del usuario autenticado sobre un documento: lo que sondea la
 * pantalla mientras el firmante hace la prueba en Didit.
 *
 * Sólo lee. No abre sesiones —eso es `StartBiometricSignatureUseCase`— ni decide el resultado,
 * que llega únicamente por el webhook firmado de Didit.
 */
@Injectable()
export class GetBiometricSignatureStatusUseCase {
  constructor(
    private readonly documentService: DocumentService,
    private readonly authorizationPolicy: DocumentAuthorizationPolicy,
    private readonly attemptService: BiometricSignatureAttemptService,
  ) {}

  /**
   * Devuelve el último intento biométrico del firmante y si su firma ya quedó registrada.
   *
   * `documentCompleted` sale del estatus del documento: una vez registrada esta firma, si ya no
   * está pendiente de firma es que era la última que faltaba.
   *
   * La URL de Didit sólo viene mientras el intento sigue abierto y vigente (ver
   * `BiometricSignatureAttemptService.toSession`).
   *
   * @param documentId - Documento consultado.
   * @param userId - Usuario autenticado (`sub` del JWT).
   * @param authorization - Contexto que dejó `PermissionsGuard` para `DOCUMENT + SIGN`.
   * @returns La sesión del último intento, o `null` si el firmante nunca inició uno.
   *
   * @throws {NotFoundException} Si el documento no existe.
   * @throws {ForbiddenException} Si el usuario no es firmante del documento o no tiene
   *   `DOCUMENT.SIGN_SELF`.
   *
   * @example
   * ```ts
   * const session = await getBiometricSignatureStatus.execute('doc-1', 'user-1', auth);
   * // → { status: 'APPROVED', signatureCompleted: true, url: null, … } | null
   * ```
   */
  async execute(
    documentId: string,
    userId: string,
    authorization: AuthorizationContext,
  ): Promise<BiometricSignatureSession | null> {
    const document = await this.documentService.findOne(documentId);
    const { myParticipant } =
      await this.documentService.findOrLinkMySignerCollaborator(
        documentId,
        userId,
        { account: true },
      );

    if (!myParticipant) {
      throw new ForbiddenException('No eres firmante de este documento');
    }

    this.authorizationPolicy.assertCanSign({
      document,
      authorization,
      participant: myParticipant,
    });

    const latest = await this.attemptService.findLatest(myParticipant.id);
    if (!latest) {
      return null;
    }

    const signatureCompleted =
      myParticipant.status === COLLABORATOR_STATUS_ENUM.SIGNED;

    return this.attemptService.toSession(latest, {
      reused: true,
      signatureCompleted,
      documentCompleted:
        signatureCompleted &&
        document.status !== DOCUMENT_STATUS_ENUM.PENDING_SIGNATURE,
    });
  }
}
