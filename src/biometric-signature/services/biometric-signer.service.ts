import {
  BadRequestException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { AuthorizationContext } from 'src/authorization/interfaces/authorization-context.interface';
import { DocumentService } from 'src/document/document.service';
import { VerificationCodeService } from 'src/document/verification-code.service';
import { DocumentAuthorizationPolicy } from 'src/document/policies/document-authorization.policy';
import { CollaboratorEntity } from 'src/document/entities/collaborator.entity';
import { DocumentEntity } from 'src/document/entities/document.entity';
import { DOCUMENT_STATUS_ENUM } from 'src/document/enum/document-status.enum';
import { SIGNATURE_TYPE_ENUM } from 'src/document/enum/signature-type.enum';
import { COLLABORATOR_STATUS_ENUM } from 'src/document/enum/collaborator-status.enum';
import { COLABORATOR_TYPE_ENUM } from 'src/document/enum/colaborator-type.enum';
import { VERIFICATION_EVENT_ENUM } from 'src/document/enum/verification-event.enum';
import { isSignerTurn } from 'src/document/utils/next-signer.util';
import { collaboratorEmail } from 'src/document/utils/collaborator-display.util';
import { GuestInvitationNotFoundException } from '../biometric-signature.exceptions';

/** Firmante ya resuelto, con su documento y los demás firmantes (para el turno). */
export interface ResolvedBiometricSigner {
  document: DocumentEntity;
  signer: CollaboratorEntity;
  signers: CollaboratorEntity[];
}

/**
 * Resuelve quién firma —con cuenta o como invitado— y comprueba que pueda iniciar AHORA una firma
 * biométrica.
 *
 * Las reglas son las mismas que aplica `SignDocumentUseCase` al registrar la firma, y se vuelven a
 * aplicar allí cuando llega la aprobación: aquí se adelantan para no gastar una sesión de Didit en
 * una firma que de todos modos se rechazaría.
 */
@Injectable()
export class BiometricSignerService {
  constructor(
    @InjectRepository(CollaboratorEntity)
    private readonly collaboratorRepository: Repository<CollaboratorEntity>,
    private readonly documentService: DocumentService,
    private readonly verificationCodeService: VerificationCodeService,
    private readonly authorizationPolicy: DocumentAuthorizationPolicy,
  ) {}

  /**
   * Resuelve al firmante autenticado: tiene que ser el usuario vinculado al colaborador y tener
   * `DOCUMENT.SIGN_SELF`.
   *
   * @param documentId - Documento.
   * @param userId - Usuario autenticado (`sub` del JWT).
   * @param authorization - Contexto de `PermissionsGuard` para `DOCUMENT + SIGN`.
   * @returns Documento, colaborador y firmantes.
   *
   * @throws {NotFoundException} Si el documento no existe.
   * @throws {ForbiddenException} Si el usuario no es firmante o no tiene `DOCUMENT.SIGN_SELF`.
   *
   * @example
   * ```ts
   * const { document, signer } = await signers.resolveAccountSigner('d-1', 'u-1', auth);
   * ```
   */
  async resolveAccountSigner(
    documentId: string,
    userId: string,
    authorization: AuthorizationContext,
  ): Promise<ResolvedBiometricSigner> {
    const document = await this.documentService.findOne(documentId);
    const { signerCollaborators, myParticipant } =
      await this.documentService.findOrLinkMySignerCollaborator(
        documentId,
        userId,
        { account: { user: true } },
      );

    if (!myParticipant) {
      throw new ForbiddenException('No eres firmante de este documento');
    }

    this.authorizationPolicy.assertCanSign({
      document,
      authorization,
      participant: myParticipant,
    });

    return { document, signer: myParticipant, signers: signerCollaborators };
  }

  /**
   * Resuelve al invitado sin cuenta a partir de su invitación: colaborador del documento, firmante,
   * sin cuenta vinculada, con firma biométrica y el mismo correo.
   *
   * @param documentId - Documento de la invitación.
   * @param collaboratorId - Colaborador de la invitación.
   * @param email - Correo de la invitación (se compara sin mayúsculas).
   * @returns Documento, colaborador y firmantes.
   *
   * @throws {NotFoundException} Si el documento no existe.
   * @throws {GuestInvitationNotFoundException} Si cualquiera de los datos no corresponde. Un solo
   *   mensaje para todos los casos: no confirma cuál falla.
   *
   * @example
   * ```ts
   * const { signer } = await signers.resolveGuestSigner('d-1', 'c-1', 'ana@correo.mx');
   * ```
   */
  async resolveGuestSigner(
    documentId: string,
    collaboratorId: string,
    email: string,
  ): Promise<ResolvedBiometricSigner> {
    const document = await this.documentService.findOne(documentId);
    const signers = await this.collaboratorRepository.find({
      where: { documentId, colaboratorType: COLABORATOR_TYPE_ENUM.SIGNER },
      relations: { account: { user: true } },
      order: { signingOrder: 'ASC' },
    });
    const signer = signers.find((c) => c.id === collaboratorId);

    const isGuestInvitation =
      !!signer &&
      !signer.accountId &&
      signer.signatureType === SIGNATURE_TYPE_ENUM.BIOMETRIC &&
      collaboratorEmail(signer).toLowerCase() === email.trim().toLowerCase();

    if (!isGuestInvitation) {
      throw new GuestInvitationNotFoundException();
    }

    return { document, signer, signers };
  }

  /**
   * Comprueba que el firmante pueda iniciar la firma biométrica en este momento.
   *
   * @param resolved - Firmante resuelto.
   * @param options.requireSignCode - Si el documento exige código de firma y hay que comprobarlo.
   *   Para el invitado no aplica: su acceso ya es un código validado en su correo.
   * @returns Nada.
   *
   * @throws {BadRequestException} Si el documento no está pendiente de firma, no tiene hash, el
   *   colaborador no es biométrico o ya respondió, o falta el código de verificación.
   * @throws {ForbiddenException} Si no es su turno en un documento secuencial.
   *
   * @example
   * ```ts
   * await signers.assertCanStart(resolved, { requireSignCode: true });
   * ```
   */
  async assertCanStart(
    resolved: ResolvedBiometricSigner,
    options: { requireSignCode: boolean },
  ): Promise<void> {
    const { document, signer, signers } = resolved;

    if (document.status !== DOCUMENT_STATUS_ENUM.PENDING_SIGNATURE) {
      throw new BadRequestException(
        `El documento no puede firmarse. Solo se permiten documentos con estatus '${DOCUMENT_STATUS_ENUM.PENDING_SIGNATURE}', el estatus actual es '${document.status}'`,
      );
    }

    if (!document.originalHash) {
      throw new BadRequestException(
        'No se pudo resolver el hash del documento para asociarlo a la firma',
      );
    }

    if (signer.signatureType !== SIGNATURE_TYPE_ENUM.BIOMETRIC) {
      throw new BadRequestException(
        'Tu firma en este documento no es biométrica',
      );
    }

    if (signer.status !== COLLABORATOR_STATUS_ENUM.PENDING) {
      throw new BadRequestException('Ya respondiste a esta solicitud de firma');
    }

    if (!isSignerTurn(signer, signers, document.isSequential)) {
      throw new ForbiddenException(
        'Aún no es tu turno para firmar este documento',
      );
    }

    if (options.requireSignCode && document.requiresVerification) {
      const hasVerified = await this.verificationCodeService.hasConsumedCode(
        document.id,
        signer.id,
        VERIFICATION_EVENT_ENUM.SIGN_DOCUMENT,
      );
      if (!hasVerified) {
        throw new BadRequestException(
          'Este documento requiere verificación. Solicita y valida tu código antes de firmar.',
        );
      }
    }
  }
}
