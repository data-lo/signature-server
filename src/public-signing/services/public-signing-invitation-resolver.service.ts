import { Injectable, NotFoundException } from '@nestjs/common';

import { summarizeSigningInvitation } from 'src/document/applications/get-public-signing-invitation.use-case';
import { CollaboratorEntity } from 'src/document/entities/collaborator.entity';
import { DocumentEntity } from 'src/document/entities/document.entity';
import { COLABORATOR_TYPE_ENUM } from 'src/document/enum/colaborator-type.enum';
import { COLLABORATOR_STATUS_ENUM } from 'src/document/enum/collaborator-status.enum';
import { DOCUMENT_STATUS_ENUM } from 'src/document/enum/document-status.enum';
import { SigningInvitationEntity } from 'src/signing-invitation/entities/signing-invitation.entity';
import { SigningInvitationService } from 'src/signing-invitation/signing-invitation.service';

import { SIGNING_INVITATION_STATUS_ENUM } from '../enums/signing-invitation-status.enum';
import { isPublicSigningAllowed } from 'src/signing-invitation/public-signing-eligibility';

/** Mensaje único para cualquier token que no sirve: no confirma si existe ni por qué falla. */
export const INVALID_INVITATION_MESSAGE = 'Esta invitación no es válida.';

/** Documentos cancelados o en proceso de cancelación. */
const CANCELLED_DOCUMENT_STATUSES: ReadonlySet<DOCUMENT_STATUS_ENUM> = new Set([
  DOCUMENT_STATUS_ENUM.CANCELLED,
  DOCUMENT_STATUS_ENUM.CANCELLATION_PENDING,
]);

/** Invitación encontrada por su token, con documento, firmante y estado. */
export interface ResolvedSigningInvitation {
  invitation: SigningInvitationEntity;
  document: DocumentEntity;
  collaborator: CollaboratorEntity;
  status: SIGNING_INVITATION_STATUS_ENUM;
}

/**
 * Estado de la invitación, del más definitivo al menos: revocada y vencida primero —un enlace
 * muerto no dice nada del documento—, luego lo que ya pasó con el firmante y con el documento.
 *
 * @param invitation - Invitación encontrada.
 * @param document - Su documento.
 * @param collaborator - Su firmante.
 * @param now - Instante de referencia.
 * @returns El estado.
 *
 * @throws Nada.
 *
 * @example
 * ```ts
 * resolveSigningInvitationStatus(invitation, document, collaborator, new Date()); // 'ACTIVE'
 * ```
 */
export function resolveSigningInvitationStatus(
  invitation: SigningInvitationEntity,
  document: DocumentEntity,
  collaborator: CollaboratorEntity,
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
  return SIGNING_INVITATION_STATUS_ENUM.ACTIVE;
}

/**
 * Resuelve el token de `/sign/:token` a su invitación, documento, firmante y estado. Es la única
 * puerta de los endpoints de invitación: ninguno recibe ids del documento ni del colaborador.
 */
@Injectable()
export class PublicSigningInvitationResolver {
  constructor(private readonly invitations: SigningInvitationService) {}

  /**
   * Resuelve un token, sea cual sea su estado.
   *
   * @param token - Token de la ruta.
   * @param now - Instante de referencia.
   * @returns La invitación con su estado.
   *
   * @throws {NotFoundException} Si el token no tiene forma de token, no existe o no es de un
   *   firmante con tipo de firma (mensaje genérico).
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
    const invitation = await this.invitations.findByToken(token);
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

    return {
      invitation,
      document,
      collaborator,
      status: resolveSigningInvitationStatus(
        invitation,
        document,
        collaborator,
        now,
      ),
    };
  }

  /**
   * Resuelve un token que tiene que estar `ACTIVE` y admitir la firma pública (enviar o validar
   * el código). Cualquier otro caso da el mismo 404 genérico.
   *
   * @param token - Token de la ruta.
   * @returns La invitación activa.
   *
   * @throws {NotFoundException} Si el token no sirve, no está activo o el firmante no puede firmar
   *   desde la invitación pública.
   *
   * @example
   * ```ts
   * const { collaborator } = await resolver.resolveActive(token);
   * ```
   */
  async resolveActive(token: string): Promise<ResolvedSigningInvitation> {
    const resolved = await this.resolve(token);
    if (
      resolved.status !== SIGNING_INVITATION_STATUS_ENUM.ACTIVE ||
      !isPublicSigningAllowed(resolved.collaborator)
    ) {
      throw new NotFoundException(INVALID_INVITATION_MESSAGE);
    }
    return resolved;
  }
}
