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
}
