/**
 * El diagrama ER-V2 no especifica los valores de este enum (solo marca `eventType: ENUM` en la
 * entidad Event). Se usa el mismo vocabulario de eventos de dominio que ya existe y se publica
 * en Kafka (ver `DOCUMENT_KAFKA_TOPICS`/`ORGANIZATION_INVITATION_KAFKA_TOPICS`) — son los
 * eventos reales que este sistema ya emite, así que son el candidato más fundamentado para
 * "qué eventos se registran" hasta que se confirme lo contrario.
 */
export enum EVENT_TYPE_ENUM {
  DOCUMENT_CREATED = 'document.created',
  DOCUMENT_SENT_TO_SIGN = 'document.sent_to_sign',
  DOCUMENT_COLLABORATOR_SIGNED = 'document.collaborator_signed',
  DOCUMENT_SIGNED = 'document.signed',
  DOCUMENT_REJECTED = 'document.rejected',
  DOCUMENT_CANCELLATION_REQUESTED = 'document.cancellation_requested',
  DOCUMENT_CANCELLED = 'document.cancelled',
  ORGANIZATION_MEMBER_INVITED = 'organization.member.invited',
  NOTIFICATION_CREATED = 'notification.created',
}
