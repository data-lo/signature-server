/**
 * Para qué se emitió un acceso temporal de invitado (`guest_signing_accesses.purpose`).
 *
 * Hoy sólo existe la Firma Electrónica Avanzada sin cuenta; el propósito forma parte de la regla
 * "un acceso activo por documento + colaborador + propósito" y viaja firmado en el token, así que
 * un acceso emitido para otra cosa nunca sirve para firmar.
 */
export enum GUEST_SIGNING_ACCESS_PURPOSE_ENUM {
  GUEST_ADVANCED_SIGNATURE_ACCESS = 'GUEST_ADVANCED_SIGNATURE_ACCESS',
  /**
   * Sesión pública de firma de una invitación individual (`/sign/:token`): la abre el código del
   * correo y la usa cualquiera de los tres tipos de firma. Viaja en cookie `HttpOnly`.
   */
  PUBLIC_SIGNING_SESSION = 'PUBLIC_SIGNING_SESSION',
}
