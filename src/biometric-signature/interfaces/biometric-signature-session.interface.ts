import { BIOMETRIC_SIGNATURE_ATTEMPT_STATUS_ENUM } from '../enums/biometric-signature-attempt-status.enum';

/**
 * Lo que el frontend necesita para llevar al firmante por Didit y saber cuándo terminó. Es la
 * respuesta de iniciar y de consultar, para firmantes con cuenta y para invitados.
 *
 * Nunca lleva el `session_token`, la API key ni el veredicto biométrico: sólo la URL hospedada y
 * el estado.
 */
export interface BiometricSignatureSession {
  attemptId: string;
  status: BIOMETRIC_SIGNATURE_ATTEMPT_STATUS_ENUM;
  /**
   * URL hospedada de Didit (para abrir o convertir en QR). `null` cuando el intento ya no está
   * abierto o la sesión venció.
   */
  url: string | null;
  expiresAt: Date | null;
  /** `true` si se devolvió una sesión que ya existía en vez de abrir otra. */
  reused: boolean;
  /** `true` cuando la firma del colaborador ya quedó registrada. */
  signatureCompleted: boolean;
  /** `true` si con esa firma el documento quedó firmado por todos. */
  documentCompleted: boolean;
}
