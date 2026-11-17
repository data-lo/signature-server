/**
 * Eventos que Firmalo notifica a los sistemas de sus clientes. Es el vocabulario del contrato
 * público (`type` del payload y header `X-Signature-Event`), no el de los eventos internos.
 *
 * Coinciden en texto con `EVENT_TYPE_ENUM`, pero son enums distintos a propósito: un evento interno
 * nuevo no debe convertirse en público por accidente. La traducción vive en `WebhookEventMapper`.
 * Agregar un tipo exige una migración que amplíe los `CHECK` de `webhook_endpoints` y
 * `webhook_deliveries`.
 */
export enum OUTBOUND_WEBHOOK_EVENT_TYPE_ENUM {
  /** Un participante registró su firma. */
  DOCUMENT_COLLABORATOR_SIGNED = 'document.collaborator_signed',
  /** Todos los firmantes completaron el documento. */
  DOCUMENT_SIGNED = 'document.signed',
  /** Un firmante rechazó el documento durante la firma. */
  DOCUMENT_REJECTED = 'document.rejected',
  /** La cancelación del documento se confirmó. */
  DOCUMENT_CANCELLED = 'document.cancelled',
}
