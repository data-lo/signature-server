import { Injectable } from '@nestjs/common';

import { DocumentEntity } from 'src/document/entities/document.entity';
import { buildDocumentAccessUrl } from 'src/document/utils/document-access-url.util';

import { SigningInvitationService } from './signing-invitation.service';

/** Firmante al que se le arma el enlace. */
export interface SignerLinkTarget {
  document: Pick<DocumentEntity, 'id' | 'createdViaApiKeyId'>;
  collaboratorId: string;
  /** Correo al que va el enlace (sólo lo usa el enlace de `/access-document`). */
  email: string;
}

/**
 * Enlace que va en el correo de un firmante.
 *
 * - **Documento creado por integración** (`createdViaApiKeyId`): invitación individual
 *   `/sign/:token`. Sus firmantes no inician sesión en la plataforma —muchos son usuarios
 *   provisionales que no pueden hacerlo—. Cada enlace emite una invitación nueva y revoca la
 *   anterior, así que el que vale es siempre el del correo más reciente.
 * - **Cualquier otro documento**: `/access-document`, como siempre.
 *
 * Es el único lugar que decide esto: lo usan los correos de alta (Kafka), la invitación inmediata
 * de firma simple y el aviso al siguiente firmante.
 */
@Injectable()
export class SigningLinkService {
  constructor(private readonly invitations: SigningInvitationService) {}

  /**
   * Enlace de firma de un colaborador.
   *
   * @param target - Documento, colaborador y correo.
   * @returns La URL para el correo.
   *
   * @throws {QueryFailedError} (23505) Si se emitió otra invitación para el mismo colaborador al
   *   mismo tiempo.
   *
   * @example
   * ```ts
   * const url = await links.signerLink({ document, collaboratorId: 'c-1', email: 'ana@acme.mx' });
   * ```
   */
  async signerLink(target: SignerLinkTarget): Promise<string> {
    if (!target.document.createdViaApiKeyId) {
      return buildDocumentAccessUrl(
        target.document.id,
        target.collaboratorId,
        target.email,
      );
    }

    const { url } = await this.invitations.issue({
      documentId: target.document.id,
      collaboratorId: target.collaboratorId,
    });
    return url;
  }
}
