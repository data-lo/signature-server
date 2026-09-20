export enum DOCUMENT_KAFKA_TOPICS {
  CREATED = 'document.created',
  /** El documento nació requiriendo aprobación y está esperando la decisión de su reviewer. */
  APPROVAL_REQUESTED = 'document.approval_requested',
  /** El reviewer autorizó: el documento entra al flujo de firma. */
  APPROVED = 'document.approved',
  /**
   * El reviewer NO autorizó. Distinto de `REJECTED`, que es un firmante rechazando el documento
   * ya dentro del flujo de firma: aquí ese flujo no llegó a empezar, y un consumidor que los
   * colapsara tendría que mirar el estado del documento para saber qué pasó realmente.
   */
  APPROVAL_REJECTED = 'document.approval_rejected',
  SENT_TO_SIGN = 'document.sent_to_sign',
  COLLABORATOR_SIGNED = 'document.collaborator_signed',
  SIGNED = 'document.signed',
  REJECTED = 'document.rejected',
  CANCELLATION_REQUESTED = 'document.cancellation_requested',
  CANCELLED = 'document.cancelled',
}

export interface DocumentEventPayload {
  documentId: string;
  fileName: string;
  actorUserId: string;
  timestamp: string;
}

/**
 * Se dispara cada vez que UN colaborador firma (a diferencia de SIGNED, que solo se dispara
 * cuando el ÚLTIMO firmante termina) — es lo que alimenta el encadenamiento de
 * DocumentTransaction (ver DocumentEventsConsumer.handleCollaboratorSigned).
 */
export interface DocumentCollaboratorSignedPayload extends DocumentEventPayload {
  collaboratorId: string;
  signedAt: string;
}

/**
 * Los tres eventos del flujo de aprobación. Llevan el colaborador REVIEWER además del documento
 * porque la pregunta que responden es "quién tiene que decidir" o "quién decidió", y el reviewer
 * es una fila concreta de `collaborators` — no basta con el documento para identificarlo.
 */
export interface DocumentApprovalEventPayload extends DocumentEventPayload {
  /** Colaborador REVIEWER asignado al documento. */
  collaboratorId: string;
  /** Comentario del reviewer al negar la aprobación; `null` en los otros dos eventos. */
  resolutionNote?: string | null;
}
