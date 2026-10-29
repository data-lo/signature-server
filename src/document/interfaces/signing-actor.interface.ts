import { AuthorizationContext } from 'src/authorization/interfaces/authorization-context.interface';

/**
 * Quién firma, ya autenticado por el mecanismo de su audiencia. La firma no lee JWT, headers ni
 * el request: recibe este actor, que resolvió un guard.
 *
 * - `AUTHENTICATED_ACCOUNT`: usuario de la plataforma con sesión (JWT). Lo arma el controlador de
 *   documentos con el `AuthorizationContext` que dejó `PermissionsGuard`; el colaborador se
 *   resuelve (o se vincula) por su usuario, como siempre.
 * - `PUBLIC_INVITATION`: firmante que entró por `/sign/:token`, validó el código de su correo y
 *   tiene una sesión pública vigente. Lo arma `PublicSigningSessionGuard`; el colaborador es el de
 *   la invitación y nunca lo elige el cliente.
 */
export type SigningActor =
  | AuthenticatedAccountSigningActor
  | PublicInvitationSigningActor;

/** Usuario de la plataforma con sesión. */
export interface AuthenticatedAccountSigningActor {
  type: 'AUTHENTICATED_ACCOUNT';
  userId: string;
  /**
   * Membresía y organización activas. `null` sólo cuando la firma no entra por una ruta con
   * `PermissionsGuard` (no hay contexto de autorización que las diga).
   */
  accountId: string | null;
  organizationId: string | null;
  /** Contexto de autorización completo, para comprobar `DOCUMENT.SIGN` con alcance `SELF`. */
  authorization?: AuthorizationContext;
}

/**
 * Por dónde llegó el firmante a su invitación: el enlace de su correo (`/sign/:token`) o el portal
 * del tercero que creó el documento (`/sign/launch/:token`). No cambia nada de la firma; queda como
 * evidencia.
 */
export type SigningAccessChannel = 'EMAIL' | 'THIRD_PARTY_PORTAL';

/** Firmante de una invitación individual, con su correo verificado por código. */
export interface PublicInvitationSigningActor {
  type: 'PUBLIC_INVITATION';
  invitationId: string;
  collaboratorId: string;
  /**
   * Usuario provisional vinculado al colaborador (firma simple de documentos de integración).
   * Ausente cuando el firmante no tiene cuenta (Firma Avanzada o biometría de invitado).
   */
  userId?: string;
  /** Cuenta vinculada al colaborador; ausente si no tiene. */
  accountId?: string;
  /** Organización del documento; `null` si es de una cuenta personal. */
  organizationId: string | null;
  /** Acceso de la sesión pública (`guest_signing_accesses`), que la firma consume. */
  sessionAccessId: string;
  /** Por dónde llegó a la invitación. */
  accessChannel: SigningAccessChannel;
  verifiedEmail: true;
}

/** Datos de la petición que se guardan como evidencia; no autorizan nada. */
export interface SigningRequestMetadata {
  ipAddress: string | null;
  userAgent: string | null;
}

/**
 * Identificador del actor para eventos y auditoría (`actorUserId`).
 *
 * @param actor - Actor de la firma.
 * @returns El usuario si lo hay; si no, `public-invitation:<colaborador>`.
 *
 * @throws Nada.
 *
 * @example
 * ```ts
 * signingActorReference({ type: 'PUBLIC_INVITATION', collaboratorId: 'c-1', … }); // 'public-invitation:c-1'
 * ```
 */
export function signingActorReference(actor: SigningActor): string {
  if (actor.type === 'AUTHENTICATED_ACCOUNT') return actor.userId;
  return actor.userId ?? `public-invitation:${actor.collaboratorId}`;
}
