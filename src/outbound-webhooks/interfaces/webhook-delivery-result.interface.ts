import { WEBHOOK_DELIVERY_ATTEMPT_OUTCOME_ENUM } from '../enums/webhook-delivery-attempt-outcome.enum';

/**
 * Resultado controlado de un POST: `WebhookHttpClient` nunca lanza por un fallo del destino, lo
 * devuelve aquí. Es lo que se guarda en `webhook_delivery_attempts` y lo que decide el reintento.
 */
export interface WebhookDeliveryResult {
  outcome: WEBHOOK_DELIVERY_ATTEMPT_OUTCOME_ENUM;
  /** Estado HTTP de la respuesta; `null` en `NETWORK_ERROR` y `TIMEOUT`. */
  responseStatus: number | null;
  durationMs: number;
  /**
   * Causa legible del fallo, recortada y sin el cuerpo de la respuesta ni headers del destino;
   * `null` en `SUCCEEDED`.
   */
  errorMessage: string | null;
  startedAt: Date;
  finishedAt: Date;
}
