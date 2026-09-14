/**
 * Idéntico a DOCUMENT_PARTICIPANT_STATUS_ENUM — renombrado a SIGNEE_STATUS para coincidir con el
 * diagrama ER-V2. Valores en mayúsculas (historia "Actualizar estatus de watchers a NOTIFIED y
 * estandarizar estatus en mayúsculas"; antes eran minúsculas, ver migración
 * `UppercaseCollaboratorStatusAddNotified`). `NOTIFIED` es exclusivo de WATCHER: se le asigna
 * cuando se le envía con éxito el correo de aviso (ver `SendPendingSignatureNotificationUseCase`);
 * un SIGNER nunca pasa por ahí.
 */
export enum SIGNEE_STATUS_ENUM {
  PENDING = 'PENDING',
  SIGNED = 'SIGNED',
  REJECTED = 'REJECTED',
  NOTIFIED = 'NOTIFIED',
}
