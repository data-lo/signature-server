import { SIGNATURE_CAPTURE_CHANNEL_ENUM } from '../enums/signature-capture-channel.enum';
import { SIGNATURE_CAPTURE_SESSION_STATUS_ENUM } from '../enums/signature-capture-session-status.enum';

/**
 * Lo que recibe la PC al abrir una captura.
 *
 * `token` y `qrUrl` son la **única** vez que el token en claro sale del servidor: en base sólo
 * queda su hash, así que no hay forma de volver a emitirlo. Si el usuario pierde el QR, lo que
 * corresponde es abrir otra sesión, no recuperar ésta.
 *
 * En el canal DESKTOP ambos llegan en `null`: esa captura no necesita token porque la hace el
 * mismo navegador autenticado que la creó, operando sobre la sesión por su `id`.
 */
export interface SignatureCaptureSessionCreated {
  id: string;
  channel: SIGNATURE_CAPTURE_CHANNEL_ENUM;
  status: SIGNATURE_CAPTURE_SESSION_STATUS_ENUM;
  expiresAt: Date;
  /** Token de un solo uso del QR. Sólo en MOBILE_QR, y sólo en esta respuesta. */
  token: string | null;
  /**
   * URL que el frontend convierte en QR. El código de barras lo dibuja el cliente: mandar una
   * imagen desde el backend sólo agregaría peso a la respuesta y una dependencia de render a un
   * flujo que ya tiene todo lo que necesita con la URL.
   */
  qrUrl: string | null;
  /** `true` si se devolvió una sesión ya abierta en lugar de crear otra. */
  reused: boolean;
}
