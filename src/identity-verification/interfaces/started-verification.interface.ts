import { IDENTITY_VERIFICATION_PROVIDER_ENUM } from '../enums/identity-verification-provider.enum';
import { IDENTITY_VERIFICATION_STATUS_ENUM } from '../enums/identity-verification-status.enum';

/**
 * Lo que el frontend recibe al arrancar una verificación.
 *
 * Nótese lo que NO está: ni la API key de Didit, ni el `session_token`, ni el `workflow_id`.
 * El cliente sólo necesita a dónde mandar al usuario.
 */
export interface StartedVerification {
  verificationId: string;
  provider: IDENTITY_VERIFICATION_PROVIDER_ENUM;
  status: IDENTITY_VERIFICATION_STATUS_ENUM;
  sessionId: string | null;
  /** URL hospedada de Didit: se abre en la misma PC o se convierte en QR para el celular. */
  url: string;
  expiresAt: Date | null;
  /** `true` si se devolvió una sesión ya existente en lugar de crear una nueva. */
  reused: boolean;
}
