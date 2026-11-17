import { ApiProperty } from '@nestjs/swagger';

import { DOCUMENT_STATUS_ENUM } from 'src/document/enum/document-status.enum';

import { OUTBOUND_WEBHOOK_EVENT_TYPE_ENUM } from '../enums/outbound-webhook-event-type.enum';
import { WEBHOOK_PAYLOAD_VERSION } from '../outbound-webhooks.constants';

/**
 * Esquemas de Swagger del payload v1 (`WebhookPayloadV1`). Sólo documentan: lo que se envía lo
 * decide `WebhookEventMapper`, y la prueba del contrato compara estos esquemas con las interfaces.
 *
 * Ninguno lleva PDF, URLs, API keys, tokens, certificados, IP, geolocalización, imágenes de firma,
 * evidencia biométrica, nombre del archivo, motivos escritos ni datos de pago.
 */

/** Documento del evento. */
export class WebhookPayloadDocument {
  @ApiProperty({
    format: 'uuid',
    example: '8f25e9d5-8998-4ec5-9a0e-1421ad48f743',
    description:
      'Identificador del documento; el mismo que devuelve la API de integración.',
  })
  id: string;

  @ApiProperty({
    enum: DOCUMENT_STATUS_ENUM,
    example: DOCUMENT_STATUS_ENUM.PENDING_SIGNATURE,
    description: 'Estado del documento justo después del hecho.',
  })
  status: DOCUMENT_STATUS_ENUM;
}

/** Participante que firmó. */
export class WebhookPayloadSignedParticipant {
  @ApiProperty({
    format: 'uuid',
    example: '77f85c29-0104-4823-8b32-4bc567e88c6a',
    description:
      'Identificador del participante; el mismo que devuelve la API de integración.',
  })
  id: string;

  @ApiProperty({ example: 'firmante@empresa.com' })
  email: string;

  @ApiProperty({ enum: ['SIGNED'], example: 'SIGNED' })
  status: 'SIGNED';

  @ApiProperty({ format: 'date-time', example: '2026-11-11T18:30:00.000Z' })
  signedAt: string;
}

/** Firmante que rechazó. El motivo escrito no se publica. */
export class WebhookPayloadRejectedParticipant {
  @ApiProperty({
    format: 'uuid',
    example: '77f85c29-0104-4823-8b32-4bc567e88c6a',
    description:
      'Identificador del participante; el mismo que devuelve la API de integración.',
  })
  id: string;

  @ApiProperty({ example: 'firmante@empresa.com' })
  email: string;

  @ApiProperty({ enum: ['REJECTED'], example: 'REJECTED' })
  status: 'REJECTED';

  @ApiProperty({ format: 'date-time', example: '2026-11-11T19:05:00.000Z' })
  rejectedAt: string;
}

/** `data` de los eventos que sólo describen el documento. */
export class WebhookPayloadDocumentData {
  @ApiProperty({ type: WebhookPayloadDocument })
  document: WebhookPayloadDocument;
}

/** `data` de `document.collaborator_signed`. */
export class WebhookPayloadCollaboratorSignedData extends WebhookPayloadDocumentData {
  @ApiProperty({ type: WebhookPayloadSignedParticipant })
  participant: WebhookPayloadSignedParticipant;
}

/** `data` de `document.rejected`. */
export class WebhookPayloadRejectedData extends WebhookPayloadDocumentData {
  @ApiProperty({ type: WebhookPayloadRejectedParticipant })
  participant: WebhookPayloadRejectedParticipant;
}

/** Campos comunes del payload v1. `type` y `data` los define cada evento. */
abstract class WebhookPayloadBase {
  @ApiProperty({
    format: 'uuid',
    example: '5d0b8c62-2f3e-4a7b-9c1d-6e4f8a2b0c13',
    description:
      'Identificador estable del evento. Igual en cada reintento: úsalo para deduplicar.',
  })
  id: string;

  @ApiProperty({
    enum: [WEBHOOK_PAYLOAD_VERSION],
    example: WEBHOOK_PAYLOAD_VERSION,
    description:
      'Versión del contrato. Un campo opcional nuevo no la cambia: ignora los campos que no conozcas.',
  })
  version: number;

  @ApiProperty({
    format: 'date-time',
    example: '2026-11-11T18:30:00.000Z',
    description:
      'Momento del hecho (ISO 8601 UTC con milisegundos), no del envío.',
  })
  occurredAt: string;
}

export class DocumentCollaboratorSignedWebhookPayload extends WebhookPayloadBase {
  @ApiProperty({
    enum: [OUTBOUND_WEBHOOK_EVENT_TYPE_ENUM.DOCUMENT_COLLABORATOR_SIGNED],
    example: OUTBOUND_WEBHOOK_EVENT_TYPE_ENUM.DOCUMENT_COLLABORATOR_SIGNED,
  })
  type: OUTBOUND_WEBHOOK_EVENT_TYPE_ENUM.DOCUMENT_COLLABORATOR_SIGNED;

  @ApiProperty({ type: WebhookPayloadCollaboratorSignedData })
  data: WebhookPayloadCollaboratorSignedData;
}

export class DocumentSignedWebhookPayload extends WebhookPayloadBase {
  @ApiProperty({
    enum: [OUTBOUND_WEBHOOK_EVENT_TYPE_ENUM.DOCUMENT_SIGNED],
    example: OUTBOUND_WEBHOOK_EVENT_TYPE_ENUM.DOCUMENT_SIGNED,
  })
  type: OUTBOUND_WEBHOOK_EVENT_TYPE_ENUM.DOCUMENT_SIGNED;

  @ApiProperty({ type: WebhookPayloadDocumentData })
  data: WebhookPayloadDocumentData;
}

export class DocumentRejectedWebhookPayload extends WebhookPayloadBase {
  @ApiProperty({
    enum: [OUTBOUND_WEBHOOK_EVENT_TYPE_ENUM.DOCUMENT_REJECTED],
    example: OUTBOUND_WEBHOOK_EVENT_TYPE_ENUM.DOCUMENT_REJECTED,
  })
  type: OUTBOUND_WEBHOOK_EVENT_TYPE_ENUM.DOCUMENT_REJECTED;

  @ApiProperty({ type: WebhookPayloadRejectedData })
  data: WebhookPayloadRejectedData;
}

export class DocumentCancelledWebhookPayload extends WebhookPayloadBase {
  @ApiProperty({
    enum: [OUTBOUND_WEBHOOK_EVENT_TYPE_ENUM.DOCUMENT_CANCELLED],
    example: OUTBOUND_WEBHOOK_EVENT_TYPE_ENUM.DOCUMENT_CANCELLED,
  })
  type: OUTBOUND_WEBHOOK_EVENT_TYPE_ENUM.DOCUMENT_CANCELLED;

  @ApiProperty({ type: WebhookPayloadDocumentData })
  data: WebhookPayloadDocumentData;
}

/** El esquema de cada evento, en el orden del contrato. */
export const WEBHOOK_PAYLOAD_MODELS = {
  [OUTBOUND_WEBHOOK_EVENT_TYPE_ENUM.DOCUMENT_COLLABORATOR_SIGNED]:
    DocumentCollaboratorSignedWebhookPayload,
  [OUTBOUND_WEBHOOK_EVENT_TYPE_ENUM.DOCUMENT_SIGNED]:
    DocumentSignedWebhookPayload,
  [OUTBOUND_WEBHOOK_EVENT_TYPE_ENUM.DOCUMENT_REJECTED]:
    DocumentRejectedWebhookPayload,
  [OUTBOUND_WEBHOOK_EVENT_TYPE_ENUM.DOCUMENT_CANCELLED]:
    DocumentCancelledWebhookPayload,
} as const;
