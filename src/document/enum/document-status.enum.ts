/**
 * Estados por los que pasa un documento, en MAYÚSCULAS y con la espera partida en dos (historia
 * "Implementar flujo de aprobación previo al proceso de firma"; ver migración
 * `UppercaseDocumentStatusAddApprovalStates`).
 *
 * `PENDING` ya no existe. Era el único estado de espera posible cuando la única espera era la de
 * los firmantes, y con la aprobación previa pasó a ser ambiguo: un documento esperando al
 * reviewer y uno esperando firmas no pueden compartir estado, porque de esa distinción depende la
 * pregunta que gobierna todo el flujo —si este documento ya se puede firmar—. Los documentos que
 * estaban en `pending` son `PENDING_SIGNATURE`: pertenecen al flujo de firma, que es el único que
 * existía.
 *
 * `PENDING_APPROVAL` es el único estado desde el que un reviewer puede aprobar o rechazar, y
 * `PENDING_SIGNATURE` el único desde el que se puede firmar (ver `SignDocumentUseCase`).
 */
export enum DOCUMENT_STATUS_ENUM {
  CREATED = 'CREATED',
  /** Esperando la decisión del reviewer asignado. Ningún firmante puede firmar ni es notificado. */
  PENDING_APPROVAL = 'PENDING_APPROVAL',
  /** El flujo de firma está abierto: es el estado al que se llega sin aprobación o tras aprobarla. */
  PENDING_SIGNATURE = 'PENDING_SIGNATURE',
  SIGNED = 'SIGNED',
  /** Rechazado, por un firmante durante la firma o por el reviewer al negar la aprobación. */
  REJECTED = 'REJECTED',
  EXPIRED = 'EXPIRED',
  CANCELLATION_PENDING = 'CANCELLATION_PENDING',
  CANCELLED = 'CANCELLED',
}
