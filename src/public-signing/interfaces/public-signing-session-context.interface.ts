import { CollaboratorEntity } from 'src/document/entities/collaborator.entity';
import { DocumentEntity } from 'src/document/entities/document.entity';
import { PublicInvitationSigningActor } from 'src/document/interfaces/signing-actor.interface';

/**
 * Lo que `PublicSigningSessionGuard` deja en el request de los endpoints de la sesión pública
 * (`request.signingSession`). Todo lo resolvió el backend a partir de la cookie: el controlador no
 * recibe del cliente ni el documento, ni el colaborador, ni el tipo de firma.
 */
export interface PublicSigningSessionContext {
  /** Actor de la firma (ver `SigningActor`). */
  actor: PublicInvitationSigningActor;
  /** Documento de la invitación, tal como está ahora. */
  document: DocumentEntity;
  /** Firmante de la invitación, con `account.user` y `simpleSignature` cargados. */
  collaborator: CollaboratorEntity;
  /** Vencimiento de la sesión (el de su acceso). */
  expiresAt: Date;
}
