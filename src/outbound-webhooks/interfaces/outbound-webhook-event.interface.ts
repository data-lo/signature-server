import { COLLABORATOR_STATUS_ENUM } from 'src/document/enum/collaborator-status.enum';
import { DOCUMENT_STATUS_ENUM } from 'src/document/enum/document-status.enum';

import { OUTBOUND_WEBHOOK_EVENT_TYPE_ENUM } from '../enums/outbound-webhook-event-type.enum';

/** Participante afectado por el evento, con lo mínimo que el contrato público puede exponer. */
export interface OutboundWebhookParticipant {
  /** `collaborators.id`. */
  id: string;
  email: string;
  status: COLLABORATOR_STATUS_ENUM;
  /** Sólo en `document.collaborator_signed`. */
  signedAt?: Date;
  /** Sólo en `document.rejected`. */
  rejectedAt?: Date;
}

/**
 * Evento interno normalizado del que sale una entrega. Lo arma quien consume el evento durable de
 * `events` y lo recibe `OutboundWebhookSubscriptionService` para decidir si se notifica.
 *
 * Lleva más de lo que se publica (`organizationId`, `createdViaApiKeyId`): esos campos sirven para
 * resolver el sujeto y el origen, y `WebhookEventMapper` los deja fuera del payload.
 */
export interface OutboundWebhookEvent {
  /** `events.id`. Es el `id` del payload y la clave de idempotencia de la entrega. */
  eventId: string;
  type: OUTBOUND_WEBHOOK_EVENT_TYPE_ENUM;
  /** Versión del contrato del evento interno (`events.version`). */
  version: number;
  /** Momento del hecho (`events.created_at`), no el de su procesamiento. */
  occurredAt: Date;
  document: {
    id: string;
    /** Estado del documento justo después del hecho. */
    status: DOCUMENT_STATUS_ENUM;
  };
  /** Organización dueña del documento; `null` en documentos personales, que no se notifican. */
  organizationId: string | null;
  /**
   * Llave de integración con la que se creó el documento; `null` si se creó desde la aplicación
   * web. En el alcance inicial sólo se notifican los documentos con llave.
   */
  createdViaApiKeyId: string | null;
  /** Presente en `document.collaborator_signed` y `document.rejected`. */
  participant?: OutboundWebhookParticipant;
}
