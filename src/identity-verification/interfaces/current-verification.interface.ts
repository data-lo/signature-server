import { IDENTITY_VERIFICATION_PROVIDER_ENUM } from '../enums/identity-verification-provider.enum';
import { IDENTITY_VERIFICATION_STATUS_ENUM } from '../enums/identity-verification-status.enum';

/**
 * Estado de identidad del usuario tal como lo consume la pantalla "Identidad y firma".
 *
 * `verification: null` es el estado "sin iniciar" — el usuario nunca arrancó un intento —, que
 * el frontend rotula como "Valida tu identidad".
 */
export interface CurrentIdentityVerification {
  verification: {
    id: string;
    provider: IDENTITY_VERIFICATION_PROVIDER_ENUM;
    status: IDENTITY_VERIFICATION_STATUS_ENUM;
    /** Sólo presente mientras la sesión sigue abierta y vigente. */
    url: string | null;
    failureReason: string | null;
    startedAt: Date | null;
    completedAt: Date | null;
    expiresAt: Date | null;
    createdAt: Date;
  } | null;
  /** Espejo de `users.signing_credential_configured`: identidad APPROVED + firma PNG registrada. */
  signingCredentialConfigured: boolean;
  identityVerifiedAt: Date | null;
  /** `true` cuando ya existe la firma PNG. Junto con el status, explica qué le falta al usuario. */
  signatureRegistered: boolean;
}
