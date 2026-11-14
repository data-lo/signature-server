/**
 * Por qué se cerró un documento. Queda en el ledger (`metadata.closureReason`) de cada crédito
 * biométrico que se consume al cerrarlo.
 */
export enum DOCUMENT_CLOSURE_REASON_ENUM {
  /** Todos los firmantes firmaron (`SIGNED`). */
  DOCUMENT_SIGNED = 'DOCUMENT_SIGNED',
  /** Un firmante lo rechazó, o el aprobador negó la aprobación (`REJECTED`). */
  DOCUMENT_REJECTED = 'DOCUMENT_REJECTED',
  /** Se confirmó su cancelación (`CANCELLED`). */
  DOCUMENT_CANCELLED = 'DOCUMENT_CANCELLED',
  /** Venció sin completarse (`EXPIRED`). */
  DOCUMENT_EXPIRED = 'DOCUMENT_EXPIRED',
}
