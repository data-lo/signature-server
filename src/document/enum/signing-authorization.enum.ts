/**
 * Cómo acreditó el firmante que era él quien firmaba (`collaborators.signing_authorization`).
 *
 * Es evidencia del acto de firma, no un estado: se escribe una sola vez, al registrar la firma, y
 * no guarda ningún secreto (ni el código, ni el token, ni la llave). Hace falta guardarla porque
 * derivarla de `account_id` deja de ser cierto si el invitado vincula una cuenta después.
 */
export enum SIGNING_AUTHORIZATION_ENUM {
  /** Firmó con sesión iniciada en su cuenta (dashboard privado). */
  ACCOUNT_SESSION = 'ACCOUNT_SESSION',
  /** Firmó sin cuenta, con un acceso temporal emitido tras validar un código en su correo. */
  GUEST_EMAIL_OTP = 'GUEST_EMAIL_OTP',
}
