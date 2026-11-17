import { OUTBOUND_WEBHOOK_EVENT_TYPE_ENUM } from '../enums/outbound-webhook-event-type.enum';

/**
 * Contrato público, versión 1, del cuerpo de un webhook. Es exactamente lo que recibe el cliente:
 * las fechas viajan como texto ISO 8601 en UTC con milisegundos.
 *
 * Nunca incluye el PDF, URLs prefirmadas, API keys, tokens, certificados, contraseñas,
 * geolocalización, IP, imágenes de firma ni evidencia biométrica. Agregar un campo opcional es
 * compatible; quitar o renombrar uno exige `version: 2`.
 */

/** Documento al que se refiere el evento. */
export interface WebhookPayloadV1Document {
  id: string;
  /** Valor de `DOCUMENT_STATUS_ENUM` justo después del hecho. */
  status: string;
}

/** Participante que firmó. */
export interface WebhookPayloadV1SignedParticipant {
  id: string;
  email: string;
  status: 'SIGNED';
  signedAt: string;
}

/** Firmante que rechazó. El motivo escrito no se publica. */
export interface WebhookPayloadV1RejectedParticipant {
  id: string;
  email: string;
  status: 'REJECTED';
  rejectedAt: string;
}

/** Campos comunes a todos los eventos. */
interface WebhookPayloadV1Base<
  TType extends OUTBOUND_WEBHOOK_EVENT_TYPE_ENUM,
  TData,
> {
  /** Identificador estable del evento de dominio; igual en cada reintento y en cada entrega. */
  id: string;
  type: TType;
  version: 1;
  /** Momento del hecho, no del envío. */
  occurredAt: string;
  data: TData;
}

export type DocumentCollaboratorSignedPayloadV1 = WebhookPayloadV1Base<
  OUTBOUND_WEBHOOK_EVENT_TYPE_ENUM.DOCUMENT_COLLABORATOR_SIGNED,
  {
    document: WebhookPayloadV1Document;
    participant: WebhookPayloadV1SignedParticipant;
  }
>;

export type DocumentSignedPayloadV1 = WebhookPayloadV1Base<
  OUTBOUND_WEBHOOK_EVENT_TYPE_ENUM.DOCUMENT_SIGNED,
  { document: WebhookPayloadV1Document }
>;

export type DocumentRejectedPayloadV1 = WebhookPayloadV1Base<
  OUTBOUND_WEBHOOK_EVENT_TYPE_ENUM.DOCUMENT_REJECTED,
  {
    document: WebhookPayloadV1Document;
    participant: WebhookPayloadV1RejectedParticipant;
  }
>;

export type DocumentCancelledPayloadV1 = WebhookPayloadV1Base<
  OUTBOUND_WEBHOOK_EVENT_TYPE_ENUM.DOCUMENT_CANCELLED,
  { document: WebhookPayloadV1Document }
>;

/** Cualquier payload de la versión 1; `type` distingue la forma de `data`. */
export type WebhookPayloadV1 =
  | DocumentCollaboratorSignedPayloadV1
  | DocumentSignedPayloadV1
  | DocumentRejectedPayloadV1
  | DocumentCancelledPayloadV1;
