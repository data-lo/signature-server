/** Valores placeholder (ver plan de migración ER-V2, Fase 7) — confirmar con producto si se necesitan más eventos. */
export enum VERIFICATION_EVENT_ENUM {
  SIGN_DOCUMENT = 'sign_document',
  REJECT_DOCUMENT = 'reject_document',
  CANCEL_DOCUMENT = 'cancel_document',
  /**
   * Código con el que un invitado sin cuenta demuestra que posee el correo de su invitación antes
   * de firmar con biometría (ver `src/biometric-signature/`).
   */
  GUEST_BIOMETRIC_ACCESS = 'guest_biometric_access',
  /**
   * Código con el que un invitado sin cuenta acredita el control del correo de su invitación para
   * firmar con Firma Electrónica Avanzada (ver `src/guest-advanced-signature/`). Sólo acredita el
   * correo: lo que autoriza la firma es el acceso temporal de `guest_signing_accesses` que se
   * emite al canjearlo.
   */
  GUEST_ADVANCED_SIGNATURE_ACCESS = 'guest_advanced_signature_access',
  /** Código con el que el firmante de una invitación individual (`/sign/:token`) abre su sesión pública. */
  PUBLIC_SIGNING_ACCESS = 'public_signing_access',
}
