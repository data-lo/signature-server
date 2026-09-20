/**
 * En qué punto de su participación está un colaborador. Antes se llamaba `SIGNEE_STATUS_ENUM`;
 * el nombre cambió con la historia "Implementar flujo de aprobación previo al proceso de firma",
 * porque desde que existe el REVIEWER la columna ya no describe sólo a quien firma.
 *
 * Los valores están en mayúsculas desde la historia "Actualizar estatus de watchers a NOTIFIED y
 * estandarizar estatus en mayúsculas" (ver migración `UppercaseCollaboratorStatusAddNotified`);
 * `APPROVED` lo agrega `AddCollaboratorApprovalFields`.
 *
 * **Qué valores puede tomar cada tipo de colaborador** es una regla de dominio y no algo que el
 * esquema pueda expresar —`status` es una sola columna con un solo tipo—, así que se escribe acá:
 *
 *  - `REVIEWER`: `PENDING` -> `APPROVED` | `REJECTED`.
 *  - `SIGNER`: `PENDING` -> `SIGNED` | `REJECTED`.
 *  - `WATCHER`: `PENDING` -> `NOTIFIED`.
 *
 * `NOTIFIED` sigue siendo exclusivo de WATCHER: se le asigna cuando se le envía con éxito el
 * correo de aviso (ver `SendPendingSignatureNotificationUseCase`). No aparece en la lista de la
 * historia porque ésta habla de reviewers y firmantes, pero quitarlo dejaría al watcher sin el
 * único estado que lo distingue de uno al que todavía no se le ha escrito.
 */
export enum COLLABORATOR_STATUS_ENUM {
  PENDING = 'PENDING',
  /** Sólo REVIEWER: autorizó que el documento salga a firma. */
  APPROVED = 'APPROVED',
  /** REVIEWER que niega la autorización, o SIGNER que rechaza el documento ya en firma. */
  REJECTED = 'REJECTED',
  /** Sólo SIGNER. */
  SIGNED = 'SIGNED',
  /** Sólo WATCHER: se le envió el correo de aviso. */
  NOTIFIED = 'NOTIFIED',
}
