import { SIGNING_CREDENTIAL_STATUS_ENUM } from 'src/user/enums/signing-credential-status.enum';
import { SIGNATURE_CAPTURE_CHANNEL_ENUM } from '../enums/signature-capture-channel.enum';
import { SIGNATURE_CAPTURE_SESSION_STATUS_ENUM } from '../enums/signature-capture-session-status.enum';

/**
 * Estado de un intento de captura: lo que la PC consulta en bucle mientras el usuario firma en el
 * teléfono.
 *
 * No lleva el token ni su hash. Quien consulta ya demostró ser su dueño con el JWT, así que
 * devolvérselo no le agregaría ninguna capacidad: sólo volvería a exponer, en cada sondeo, el secreto
 * que el QR ya entregó una vez.
 *
 * Incluye `signingCredentialStatus` a propósito: cuando el teléfono termina, la PC pasa sola a "firma
 * registrada" con la misma respuesta que ya está pidiendo, sin una segunda consulta al perfil.
 */
export interface SignatureCaptureSessionStatus {
  id: string;
  channel: SIGNATURE_CAPTURE_CHANNEL_ENUM;
  status: SIGNATURE_CAPTURE_SESSION_STATUS_ENUM;
  expiresAt: Date;
  claimedAt: Date | null;
  completedAt: Date | null;
  /** Firma que produjo este intento; `null` mientras no haya terminado. */
  signatureId: string | null;
  signingCredentialStatus: SIGNING_CREDENTIAL_STATUS_ENUM;
}
