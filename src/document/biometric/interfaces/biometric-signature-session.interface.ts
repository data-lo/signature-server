import { BIOMETRIC_SIGNATURE_ATTEMPT_STATUS_ENUM } from '../enums/biometric-signature-attempt-status.enum';

/**
 * Lo que el frontend necesita para llevar al firmante por la prueba biométrica y saber cuándo
 * terminó. Respuesta de iniciar (`POST`) y de consultar (`GET`) la firma biométrica.
 *
 * Nunca lleva el `session_token`, la API key ni el veredicto de Didit: sólo la URL hospedada y el
 * estado.
 */
export interface BiometricSignatureSession {
  attemptId: string;
  status: BIOMETRIC_SIGNATURE_ATTEMPT_STATUS_ENUM;
  /**
   * URL hospedada de Didit, que el frontend abre o convierte en QR. `null` cuando el intento ya no
   * está abierto o la sesión venció: una URL muerta sólo llevaría a una pantalla sin salida.
   */
  url: string | null;
  expiresAt: Date | null;
  /** `true` si se devolvió una sesión que ya existía en vez de abrir otra. */
  reused: boolean;
  /** `true` cuando la firma del colaborador ya quedó registrada. */
  signatureCompleted: boolean;
  /**
   * `true` si el documento ya quedó firmado por todos. Es lo que el acuse de firma necesita para
   * elegir su texto, igual que `documentCompleted` de `PATCH /document/:id/sign`.
   */
  documentCompleted: boolean;
}
