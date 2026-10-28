import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { summarizeSigningInvitation } from 'src/document/applications/get-public-signing-invitation.use-case';
import { CollaboratorEntity } from 'src/document/entities/collaborator.entity';
import { DocumentEntity } from 'src/document/entities/document.entity';
import { COLABORATOR_TYPE_ENUM } from 'src/document/enum/colaborator-type.enum';
import { COLLABORATOR_STATUS_ENUM } from 'src/document/enum/collaborator-status.enum';
import { DOCUMENT_STATUS_ENUM } from 'src/document/enum/document-status.enum';
import { isSignerTurn } from 'src/document/utils/next-signer.util';
import { SigningInvitationEntity } from 'src/signing-invitation/entities/signing-invitation.entity';
import { isPublicSigningAllowed } from 'src/signing-invitation/public-signing-eligibility';
import { SigningInvitationService } from 'src/signing-invitation/signing-invitation.service';

import { SIGNING_INVITATION_STATUS_ENUM } from '../enums/signing-invitation-status.enum';

/** Mensaje único para cualquier token que no sirve: no confirma si existe ni por qué falla. */
export const INVALID_INVITATION_MESSAGE = 'Esta invitación no es válida.';

/** Documentos cancelados o en proceso de cancelación. */
const CANCELLED_DOCUMENT_STATUSES: ReadonlySet<DOCUMENT_STATUS_ENUM> = new Set([
  DOCUMENT_STATUS_ENUM.CANCELLED,
  DOCUMENT_STATUS_ENUM.CANCELLATION_PENDING,
]);

/** Invitación encontrada, con documento, firmante y estado. */
export interface ResolvedSigningInvitation {
  invitation: SigningInvitationEntity;
  document: DocumentEntity;
  collaborator: CollaboratorEntity;
  status: SIGNING_INVITATION_STATUS_ENUM;
}

/**
 * Estado de la invitación, del más definitivo al menos: revocada y vencida primero —un enlace
 * muerto no dice nada del documento—, luego lo que ya pasó con el firmante y con el documento, y
 * al final el turno.
 *
 * @param invitation - Invitación encontrada.
 * @param document - Su documento.
 * @param collaborator - Su firmante.
 * @param signers - Firmantes del documento, para el turno; sin ellos no se evalúa.
 * @param now - Instante de referencia.
 * @returns El estado.
 *
 * @throws Nada.
 *
 * @example
 * ```ts
 * resolveSigningInvitationStatus(invitation, document, collaborator, signers, new Date()); // 'ACTIVE'
 * ```
 */
export function resolveSigningInvitationStatus(
  invitation: SigningInvitationEntity,
  document: DocumentEntity,
  collaborator: CollaboratorEntity,
  signers: CollaboratorEntity[],
  now: Date,
): SIGNING_INVITATION_STATUS_ENUM {
  if (invitation.revokedAt) return SIGNING_INVITATION_STATUS_ENUM.REVOKED;
  if (invitation.expiresAt.getTime() <= now.getTime()) {
    return SIGNING_INVITATION_STATUS_ENUM.EXPIRED;
  }
  if (
    collaborator.status === COLLABORATOR_STATUS_ENUM.SIGNED ||
    document.status === DOCUMENT_STATUS_ENUM.SIGNED
  ) {
    return SIGNING_INVITATION_STATUS_ENUM.ALREADY_SIGNED;
  }
  if (CANCELLED_DOCUMENT_STATUSES.has(document.status)) {
    return SIGNING_INVITATION_STATUS_ENUM.DOCUMENT_CANCELLED;
  }
  if (!summarizeSigningInvitation(document, collaborator).availableForSigning) {
    return SIGNING_INVITATION_STATUS_ENUM.UNAVAILABLE;
  }
  if (
    signers.length > 0 &&
    !isSignerTurn(collaborator, signers, document.isSequential)
  ) {
    return SIGNING_INVITATION_STATUS_ENUM.WAITING_FOR_PREVIOUS_SIGNER;
  }
  return SIGNING_INVITATION_STATUS_ENUM.ACTIVE;
}

/**
 * Resuelve una invitación —por su token (`/sign/:token`) o por su id (cookie de acceso, a la que se
 * llega desde el correo o desde el portal del tercero)— a su documento, firmante y estado. Ningún
 * endpoint público recibe ids del documento ni del colaborador.
 */
@Injectable()
export class PublicSigningInvitationResolver {
  constructor(
    private readonly invitations: SigningInvitationService,
    @InjectRepository(CollaboratorEntity)
    private readonly collaboratorRepository: Repository<CollaboratorEntity>,
  ) {}

  /**
   * Resuelve un token de invitación, sea cual sea su estado.
   *
   * @param token - Token de la ruta.
   * @param now - Instante de referencia.
   * @returns La invitación con su estado.
   *
   * @throws {NotFoundException} Si el token no existe o no es de un firmante (mensaje genérico).
   *
   * @example
   * ```ts
   * const { status } = await resolver.resolve(token);
   * ```
   */
  async resolve(
    token: string,
    now: Date = new Date(),
  ): Promise<ResolvedSigningInvitation> {
    return this.present(await this.invitations.findByToken(token), now);
  }

  /**
   * Resuelve una invitación por su id (el que lleva la cookie de acceso).
   *
   * @param invitationId - Id de la invitación.
   * @param now - Instante de referencia.
   * @returns La invitación con su estado.
   *
   * @throws {NotFoundException} Si no existe o no es de un firmante (mensaje genérico).
   *
   * @example
   * ```ts
   * const resolved = await resolver.resolveById(claims.invitationId);
   * ```
   */
  async resolveById(
    invitationId: string,
    now: Date = new Date(),
  ): Promise<ResolvedSigningInvitation> {
    return this.present(await this.invitations.findById(invitationId), now);
  }

  /**
   * Exige que una invitación resuelta esté `ACTIVE` y admita la firma pública (enviar o validar el
   * código). Cualquier otro caso da el mismo 404 genérico.
   *
   * @param resolved - Invitación resuelta.
   * @returns La misma invitación.
   *
   * @throws {NotFoundException} Si no está activa o el firmante no puede firmar desde la invitación.
   *
   * @example
   * ```ts
   * resolver.assertActive(resolved);
   * ```
   */
  assertActive(resolved: ResolvedSigningInvitation): ResolvedSigningInvitation {
    if (
      resolved.status !== SIGNING_INVITATION_STATUS_ENUM.ACTIVE ||
      !isPublicSigningAllowed(resolved.collaborator)
    ) {
      throw new NotFoundException(INVALID_INVITATION_MESSAGE);
    }
    return resolved;
  }

  private async present(
    invitation: SigningInvitationEntity | null,
    now: Date,
  ): Promise<ResolvedSigningInvitation> {
    const document = invitation?.document;
    const collaborator = invitation?.collaborator;

    if (!invitation || !document || !collaborator) {
      throw new NotFoundException(INVALID_INVITATION_MESSAGE);
    }
    // Sólo firmantes con tipo de firma: testigos y revisores no se firman por aquí.
    if (
      !collaborator.signatureType ||
      collaborator.colaboratorType !== COLABORATOR_TYPE_ENUM.SIGNER
    ) {
      throw new NotFoundException(INVALID_INVITATION_MESSAGE);
    }

    const signers = await this.collaboratorRepository.find({
      where: {
        documentId: document.id,
        colaboratorType: COLABORATOR_TYPE_ENUM.SIGNER,
      },
      order: { signingOrder: 'ASC' },
    });

    return {
      invitation,
      document,
      collaborator,
      status: resolveSigningInvitationStatus(
        invitation,
        document,
        collaborator,
        signers,
        now,
      ),
    };
  }
}
