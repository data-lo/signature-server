import { OUTBOUND_WEBHOOK_EVENT_TYPE_ENUM } from '../enums/outbound-webhook-event-type.enum';

/**
 * Headers con los que se identifica y verifica cada intento de entrega. Las claves son los nombres
 * de `WEBHOOK_HEADERS`; `Content-Type: application/json` y `User-Agent` los pone `WebhookHttpClient`.
 */
export interface WebhookSignatureHeaders {
  /** `webhook_deliveries.id`: el mismo en todos los reintentos de la entrega. */
  'x-signature-webhook-id': string;
  'x-signature-event': OUTBOUND_WEBHOOK_EVENT_TYPE_ENUM;
  /** Segundos Unix en decimal; cambia en cada intento. */
  'x-signature-timestamp': string;
  /** HMAC-SHA256 en hexadecimal minúsculo de `<timestamp>.<cuerpo>`; cambia en cada intento. */
  'x-signature-hmac': string;
}
