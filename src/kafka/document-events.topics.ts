export enum DOCUMENT_KAFKA_TOPICS {
  CREATED = 'document.created',
  SENT_TO_SIGN = 'document.sent_to_sign',
  SIGNED = 'document.signed',
  REJECTED = 'document.rejected',
  CANCELLED = 'document.cancelled',
}

export interface DocumentEventPayload {
  documentId: string;
  fileName: string;
  actorUserId: string;
  timestamp: string;
}
