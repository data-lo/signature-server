import {
  BadRequestException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { DocumentService } from 'src/document/document.service';
import { CollaboratorEntity } from 'src/document/entities/collaborator.entity';
import { DocumentEntity } from 'src/document/entities/document.entity';
import { DOCUMENT_STATUS_ENUM } from 'src/document/enum/document-status.enum';
import { SIGNATURE_TYPE_ENUM } from 'src/document/enum/signature-type.enum';
import { COLLABORATOR_STATUS_ENUM } from 'src/document/enum/collaborator-status.enum';
import { COLABORATOR_TYPE_ENUM } from 'src/document/enum/colaborator-type.enum';
import { isSignerTurn } from 'src/document/utils/next-signer.util';
import { GuestAdvancedInvitationNotFoundException } from 'src/document/exceptions/guest-signing-access.exceptions';

/** Invitado ya resuelto, con su documento y los demás firmantes (para el turno). */
export interface ResolvedGuestAdvancedSigner {
  document: DocumentEntity;
  signer: CollaboratorEntity;
  signers: CollaboratorEntity[];
}

/**
 * Resuelve al invitado sin cuenta de una Firma Avanzada y comprueba que pueda pedir acceso.
 *
 * Es la primera de dos validaciones: la segunda la hace `SignDocumentUseCase.executeGuestAdvanced`
 * justo antes de firmar, porque entre una y otra el documento o la invitación pueden cambiar.
 */
@Injectable()
export class GuestAdvancedSignerService {
  constructor(
    @InjectRepository(CollaboratorEntity)
    private readonly collaboratorRepository: Repository<CollaboratorEntity>,
    private readonly documentService: DocumentService,
  ) {}

  /**
   * Resuelve la invitación: colaborador firmante del documento, con Firma Avanzada (FIEL), sin
   * cuenta vinculada y, si se indica, con ese correo.
   *
   * El correo del enlace sólo IDENTIFICA la invitación; no prueba nada. Lo que prueba el control
   * del correo es el código que se envía al correo guardado del colaborador.
   *
   * @param documentId - Documento de la invitación.
   * @param collaboratorId - Colaborador de la invitación.
   * @param email - Correo del enlace (se compara sin mayúsculas ni espacios). `null` cuando la
   *   invitación ya se acreditó con un acceso, que guarda su propio hash del correo.
   * @returns Documento, colaborador y firmantes.
   *
   * @throws {NotFoundException} Si el documento no existe.
   * @throws {GuestAdvancedInvitationNotFoundException} Si cualquiera de los datos no corresponde.
   *   Un solo mensaje para todos los casos: no confirma cuál falla.
   *
   * @example
   * ```ts
   * const { signer } = await signers.resolveGuestSigner('d-1', 'c-1', 'ana@correo.mx');
   * ```
   */
  async resolveGuestSigner(
    documentId: string,
    collaboratorId: string,
    email: string | null,
  ): Promise<ResolvedGuestAdvancedSigner> {
    const document = await this.documentService.findOne(documentId);
    const signers = await this.collaboratorRepository.find({
      where: { documentId, colaboratorType: COLABORATOR_TYPE_ENUM.SIGNER },
      order: { signingOrder: 'ASC' },
    });
    const signer = signers.find((c) => c.id === collaboratorId);

    const isGuestInvitation =
      !!signer &&
      !signer.accountId &&
      signer.signatureType === SIGNATURE_TYPE_ENUM.FIEL &&
      !!signer.email &&
      (email === null ||
        signer.email.trim().toLowerCase() === email.trim().toLowerCase());

    if (!isGuestInvitation) {
      throw new GuestAdvancedInvitationNotFoundException();
    }

    return { document, signer, signers };
  }

  /**
   * Comprueba que el invitado pueda acreditarse AHORA: documento pendiente de firma, él pendiente
   * y en su turno. Se aplica al pedir el código y otra vez al canjearlo.
   *
   * @param resolved - Invitado resuelto.
   * @returns Nada.
   *
   * @throws {BadRequestException} Si el documento no está pendiente de firma o el invitado ya
   *   respondió.
   * @throws {ForbiddenException} Si todavía no es su turno en un documento secuencial.
   *
   * @example
   * ```ts
   * signers.assertCanRequestAccess(resolved);
   * ```
   */
  assertCanRequestAccess(resolved: ResolvedGuestAdvancedSigner): void {
    const { document, signer, signers } = resolved;

    if (document.status !== DOCUMENT_STATUS_ENUM.PENDING_SIGNATURE) {
      throw new BadRequestException(
        'Este documento ya no está pendiente de firma.',
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
  }
}
