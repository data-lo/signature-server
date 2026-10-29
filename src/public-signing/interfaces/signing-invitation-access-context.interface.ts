import { SigningAccessChannel } from 'src/document/interfaces/signing-actor.interface';

import { ResolvedSigningInvitation } from '../services/public-signing-invitation-resolver.service';

/**
 * Lo que `SigningInvitationAccessGuard` deja en `request.signingInvitationAccess`: la invitación
 * resuelta desde la cookie de acceso y el canal por el que se llegó. Con esto se pide y se valida
 * el código; no da acceso al documento.
 */
export interface SigningInvitationAccessContext {
  resolved: ResolvedSigningInvitation;
  channel: SigningAccessChannel;
}
