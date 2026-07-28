export enum DOCUMENT_KAFKA_TOPICS {
  CREATED = 'document.created',
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
