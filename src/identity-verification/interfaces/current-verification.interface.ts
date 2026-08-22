import { SIGNING_CREDENTIAL_STATUS_ENUM } from 'src/user/enums/signing-credential-status.enum';
import { IDENTITY_VERIFICATION_PROVIDER_ENUM } from '../enums/identity-verification-provider.enum';
import { IDENTITY_VERIFICATION_STATUS_ENUM } from '../enums/identity-verification-status.enum';
import { IdentityVerificationChecks } from './identity-checks.interface';

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
    /**
     * Qué comprobó el proveedor y cómo salió cada cosa. `null` cuando el intento todavía no
     * tiene veredicto o cuando no se pudo leer ninguna comprobación.
     */
    checks: IdentityVerificationChecks | null;
    startedAt: Date | null;
    completedAt: Date | null;
    expiresAt: Date | null;
    createdAt: Date;
  } | null;
  /**
   * Estado global del avance de identidad y firma (`users.signing_credential_status`). Es lo
   * que el frontend usa para habilitar o deshabilitar cada paso de la pantalla.
   */
  signingCredentialStatus: SIGNING_CREDENTIAL_STATUS_ENUM;
  /** Conveniencia derivada: `signingCredentialStatus === CONFIGURED`. */
  signingCredentialConfigured: boolean;
  identityVerifiedAt: Date | null;
  /** `true` cuando ya existe la firma PNG. Junto con el status, explica qué le falta al usuario. */
  signatureRegistered: boolean;
}
