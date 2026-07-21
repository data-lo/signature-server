export enum NOTIFICATION_KAFKA_TOPICS {
  CREATED = 'notification.created',
}

/**
 * Metadata técnica de la notificación (fila real de `notifications`), no el contenido del
 * correo en sí — los workers consumidores (ej. de envío de correo) resuelven el resto (a quién,
 * qué documento, qué plantilla) a partir de `collaboratorId`/`documentId`.
 */
export interface NotificationEventPayload {
  notificationId: string;
  documentId: string;
  collaboratorId: string;
  actorType: string;
  notificationChannelSource: string;
  timestamp: string;
}
