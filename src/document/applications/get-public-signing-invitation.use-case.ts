import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { CollaboratorEntity } from '../entities/collaborator.entity';
import { DocumentEntity } from '../entities/document.entity';
import { COLABORATOR_TYPE_ENUM } from '../enum/colaborator-type.enum';
import { COLLABORATOR_STATUS_ENUM } from '../enum/collaborator-status.enum';
import { DOCUMENT_STATUS_ENUM } from '../enum/document-status.enum';
import { SIGNATURE_TYPE_ENUM } from '../enum/signature-type.enum';
import { collaboratorEmail } from '../utils/collaborator-display.util';
import { maskEmail } from '../utils/mask-email.util';

/**
 * Tipos de firma que un invitado puede completar sin cuenta desde la pantalla pública.
 *
 * Sólo biometría por ahora: la Firma Avanzada pública (OTP + `.cer`/`.key`) llega en otra historia,
 * y mientras tanto ofrecer "Continuar sin cuenta" a un firmante FIEL lo llevaría a un callejón sin
 * salida. Al integrarla, basta con agregar `FIEL` aquí.
 */
const GUEST_SIGNING_TYPES: ReadonlySet<SIGNATURE_TYPE_ENUM> = new Set([
  SIGNATURE_TYPE_ENUM.BIOMETRIC,
]);

/** Lo que la pantalla pública de firma necesita para decidir cómo sigue el invitado. */
export interface PublicSigningInvitation {
  /** Nombre del documento ("Vas a firmar: …"). */
  documentName: string;
  /** Correo invitado, enmascarado (`a***@empresa.com`). Nunca el correo completo. */
  maskedEmail: string;
  /** Tipo de firma que exige el documento a este firmante; lo decide el backend, no el invitado. */
  signatureType: SIGNATURE_TYPE_ENUM | null;
  /** `true` si el documento sigue pendiente de firma y este firmante todavía no respondió. */
  availableForSigning: boolean;
  /** `true` si puede continuar sin cuenta: no tiene cuenta vinculada y su tipo lo admite. */
  guestSigningAllowed: boolean;
}

/**
 * `GET /public/documents/:documentId/invitation?collaboratorId=`: valida la invitación de un
 * firmante para la pantalla pública `/public/documents/:id/sign`, antes de que el invitado elija
 * entre iniciar sesión o continuar sin cuenta.
 *
 * La invitación se identifica sólo por documento + colaborador. El correo del enlace no participa:
 * lo que se muestra es el guardado en el colaborador, enmascarado, y no sirve para autorizar nada.
 * Nada de esto da acceso al PDF; para eso el invitado inicia sesión o valida un código en su correo.
 */
@Injectable()
export class GetPublicSigningInvitationUseCase {
  constructor(
    @InjectRepository(DocumentEntity)
    private readonly documentRepository: Repository<DocumentEntity>,
    @InjectRepository(CollaboratorEntity)
    private readonly collaboratorRepository: Repository<CollaboratorEntity>,
  ) {}

  /**
   * Valida la invitación y resume lo necesario para decidir el flujo.
   *
   * @param documentId - Documento del enlace.
   * @param collaboratorId - Colaborador del enlace (`invitationReference`).
   * @returns Nombre del documento, correo enmascarado, tipo de firma, disponibilidad y si admite
   *   continuar sin cuenta.
   *
   * @throws {NotFoundException} Si el documento no existe o el colaborador no es firmante de él.
   *   Un solo mensaje para los dos casos: no confirma cuál falla.
   *
   * @example
   * ```ts
   * const invitation = await getPublicSigningInvitation.execute('d-1', 'c-1');
   * // { documentName: 'contrato.pdf', maskedEmail: 'a***@empresa.com', signatureType: 'BIOMETRIC', … }
   * ```
   */
  async execute(
    documentId: string,
    collaboratorId: string,
  ): Promise<PublicSigningInvitation> {
    const [document, collaborator] = await Promise.all([
      this.documentRepository.findOne({ where: { id: documentId } }),
      this.collaboratorRepository.findOne({
        where: {
          id: collaboratorId,
          documentId,
          colaboratorType: COLABORATOR_TYPE_ENUM.SIGNER,
        },
        relations: { account: { user: true } },
      }),
    ]);

    if (!document || !collaborator) {
      throw new NotFoundException('Esta invitación no es válida.');
    }

    const signatureType = collaborator.signatureType ?? null;

    return {
      documentName: document.fileName,
      maskedEmail: maskEmail(
        collaborator.email ?? collaboratorEmail(collaborator),
      ),
      signatureType,
      availableForSigning:
        document.status === DOCUMENT_STATUS_ENUM.PENDING_SIGNATURE &&
        collaborator.status === COLLABORATOR_STATUS_ENUM.PENDING,
      guestSigningAllowed:
        !collaborator.accountId &&
        !!signatureType &&
        GUEST_SIGNING_TYPES.has(signatureType),
    };
  }
}
