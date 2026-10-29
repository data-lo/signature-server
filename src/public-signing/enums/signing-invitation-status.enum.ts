/**
 * Estado de una invitación individual de firma (`GET /public/signing-invitations/:token`).
 *
 * Sólo `ACTIVE` viene con datos del documento y del firmante. Los demás llegan solos, para que un
 * enlace vencido, revocado o de un documento cerrado no publique nada del documento. Un token que
 * no existe no tiene estado: responde 404.
 *
 * - `ACTIVE`: el documento espera la firma de este firmante.
 * - `EXPIRED`: la invitación venció.
 * - `REVOKED`: la invitación se revocó (se emitió otra para el mismo firmante, o se retiró).
 * - `ALREADY_SIGNED`: el firmante ya firmó, o el documento ya quedó firmado por todos.
 * - `DOCUMENT_CANCELLED`: el documento se canceló o está en proceso de cancelación.
 * - `WAITING_FOR_PREVIOUS_SIGNER`: el documento es secuencial y todavía no es el turno de este
 *   firmante. Se informa sin datos del documento; puede volver a abrir su enlace cuando le toque.
 * - `UNAVAILABLE`: el documento no admite la firma de este firmante (rechazado, vencido, todavía en
 *   aprobación o el firmante ya lo rechazó).
 */
export enum SIGNING_INVITATION_STATUS_ENUM {
  ACTIVE = 'ACTIVE',
  EXPIRED = 'EXPIRED',
  REVOKED = 'REVOKED',
  ALREADY_SIGNED = 'ALREADY_SIGNED',
  DOCUMENT_CANCELLED = 'DOCUMENT_CANCELLED',
  UNAVAILABLE = 'UNAVAILABLE',
  WAITING_FOR_PREVIOUS_SIGNER = 'WAITING_FOR_PREVIOUS_SIGNER',
}
