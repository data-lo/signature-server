import { Injectable, Logger } from '@nestjs/common';
import { Counter, Gauge, Histogram } from '@prometheus-io/client';

import { WEBHOOK_PROCESSING_STATUS_ENUM } from 'src/webhooks/enums/webhook-processing-status.enum';
import { WEBHOOK_PROVIDER_ENUM } from 'src/webhooks/enums/webhook-provider.enum';

import { HTTP_REQUEST_DURATION_BUCKETS } from './metrics.constants';
import { MetricsService } from './metrics.service';

/** Resultado final de una entrega de webhook. */
export type WebhookDeliveryOutcome =
  | 'processed'
  | 'duplicate'
  | 'rejected'
  | 'failed'
  | 'ignored';

/** Una entrega de webhook ya atendida. */
export interface WebhookDeliverySample {
  provider: WEBHOOK_PROVIDER_ENUM;
  eventType: string;
  outcome: WebhookDeliveryOutcome;
  durationSeconds: number;
}

/** `event_type` de una entrega cuya firma no verificó: su cuerpo no se lee. */
export const WEBHOOK_UNVERIFIED_EVENT_TYPE = 'unverified';

/** `event_type` de una entrega con firma válida pero con un cuerpo fuera del contrato. */
export const WEBHOOK_INVALID_PAYLOAD_EVENT_TYPE = 'invalid_payload';

/** `event_type` de un valor que no pertenece al vocabulario del proveedor. */
export const WEBHOOK_UNKNOWN_EVENT_TYPE = 'unknown';

/** Tipos de webhook que documenta Didit. `webhook_type` sólo se valida como texto en la recepción. */
const DIDIT_EVENT_TYPES: ReadonlySet<string> = new Set([
  'status.updated',
  'data.updated',
]);

/**
 * Forma de un tipo de evento de Stripe (`customer.subscription.updated`). Stripe agrega tipos con
 * frecuencia, así que una lista fija los dejaría en `unknown` sin que nadie lo notara.
 */
const STRIPE_EVENT_TYPE_PATTERN = /^[a-z0-9_]+(\.[a-z0-9_]+){1,5}$/;

const STRIPE_EVENT_TYPE_MAX_LENGTH = 100;

/**
 * Métricas del ciclo de vida de los webhooks.
 *
 * Ningún método lanza: una métrica que falla se registra en el log y nada más, porque un error aquí
 * no puede convertir una entrega correcta en un 5xx y provocar reintentos del proveedor.
 */
@Injectable()
export class WebhookMetricsService {
  private readonly logger = new Logger(WebhookMetricsService.name);

  private readonly deliveriesTotal: Counter<
    'provider' | 'event_type' | 'outcome'
  >;
  private readonly deliveryDuration: Histogram<
    'provider' | 'event_type' | 'outcome'
  >;
  private readonly signatureVerificationsTotal: Counter<'provider' | 'result'>;
  private readonly dispatchTotal: Counter<'provider' | 'target'>;
  private readonly eventsPending: Gauge<'provider' | 'status'>;
  private readonly oldestPendingSeconds: Gauge<'provider' | 'status'>;

  constructor(private readonly metrics: MetricsService) {
    this.deliveriesTotal = metrics.createCounter({
      name: 'webhook_deliveries_total',
      help: 'Entregas de webhook atendidas, por resultado.',
      labelNames: ['provider', 'event_type', 'outcome'],
    });
    this.deliveryDuration = metrics.createHistogram({
      name: 'webhook_delivery_duration_seconds',
      help: 'Duración de la atención de una entrega de webhook, en segundos.',
      labelNames: ['provider', 'event_type', 'outcome'],
      buckets: HTTP_REQUEST_DURATION_BUCKETS,
    });
    this.signatureVerificationsTotal = metrics.createCounter({
      name: 'webhook_signature_verifications_total',
      help: 'Verificaciones de firma de webhooks, por resultado.',
      labelNames: ['provider', 'result'],
    });
    this.dispatchTotal = metrics.createCounter({
      name: 'webhook_dispatch_total',
      help: 'Entregas de webhook que el destino atendió sin error.',
      labelNames: ['provider', 'target'],
    });
    this.eventsPending = metrics.createGauge({
      name: 'webhook_events_pending',
      help: 'Filas de webhook_events sin resolver, sin contar los rechazos de auditoría.',
      labelNames: ['provider', 'status'],
    });
    this.oldestPendingSeconds = metrics.createGauge({
      name: 'webhook_oldest_pending_seconds',
      help: 'Segundos desde el último intento de la fila sin resolver más antigua.',
      labelNames: ['provider', 'status'],
    });
  }

  /**
   * Indica si las métricas están activas.
   *
   * @returns `false` si `METRICS_ENABLED` no las activó.
   *
   * @example
   * ```ts
   * if (!webhookMetrics.isEnabled()) return;
   * ```
   */
  isEnabled(): boolean {
    return this.metrics.isEnabled();
  }

  /**
   * Registra el resultado y la duración de una entrega.
   *
   * @param sample - Entrega atendida.
   * @returns Nada.
   *
   * @example
   * ```ts
   * webhookMetrics.recordDelivery({
   *   provider: WEBHOOK_PROVIDER_ENUM.STRIPE,
   *   eventType: 'invoice.paid',
   *   outcome: 'processed',
   *   durationSeconds: 0.12,
   * });
   * ```
   */
  recordDelivery(sample: WebhookDeliverySample): void {
    this.safely(() => {
      const labels = {
        provider: sample.provider,
        event_type: this.normalizeEventType(sample.provider, sample.eventType),
        outcome: sample.outcome,
      };
      this.deliveriesTotal.inc(labels);
      this.deliveryDuration.observe(labels, sample.durationSeconds);
    });
  }

  /**
   * Registra el resultado de verificar la firma de una entrega.
   *
   * @param provider - Proveedor que dice haberla enviado.
   * @param valid - Si la firma verificó.
   * @returns Nada.
   *
   * @example
   * ```ts
   * webhookMetrics.recordSignatureVerification(WEBHOOK_PROVIDER_ENUM.DIDIT, false);
   * ```
   */
  recordSignatureVerification(
    provider: WEBHOOK_PROVIDER_ENUM,
    valid: boolean,
  ): void {
    this.safely(() =>
      this.signatureVerificationsTotal.inc({
        provider,
        result: valid ? 'valid' : 'invalid',
      }),
    );
  }

  /**
   * Registra a qué destino se entregó un evento autenticado.
   *
   * @param provider - Proveedor de la entrega.
   * @param target - Destino de un vocabulario fijo del código (`payments`, `ignored`...).
   * @returns Nada.
   *
   * @example
   * ```ts
   * webhookMetrics.recordDispatch(WEBHOOK_PROVIDER_ENUM.DIDIT, 'biometric-signature');
   * ```
   */
  recordDispatch(provider: WEBHOOK_PROVIDER_ENUM, target: string): void {
    this.safely(() => this.dispatchTotal.inc({ provider, target }));
  }

  /**
   * Publica la cantidad y la antigüedad de las filas sin resolver de un proveedor y estado.
   *
   * @param provider - Proveedor.
   * @param status - Estado de procesamiento.
   * @param pending - Cantidad de filas.
   * @param oldestSeconds - Antigüedad de la más antigua; `0` si no hay filas.
   * @returns Nada.
   *
   * @example
   * ```ts
   * webhookMetrics.setBacklog(
   *   WEBHOOK_PROVIDER_ENUM.STRIPE,
   *   WEBHOOK_PROCESSING_STATUS_ENUM.FAILED,
   *   2,
   *   340,
   * );
   * ```
   */
  setBacklog(
    provider: WEBHOOK_PROVIDER_ENUM,
    status: WEBHOOK_PROCESSING_STATUS_ENUM,
    pending: number,
    oldestSeconds: number,
  ): void {
    this.safely(() => {
      this.eventsPending.set({ provider, status }, pending);
      this.oldestPendingSeconds.set({ provider, status }, oldestSeconds);
    });
  }

  /**
   * Reduce el tipo de evento al vocabulario del proveedor, para que un valor inesperado no pueda
   * crear series sin límite.
   *
   * @param provider - Proveedor de la entrega.
   * @param eventType - Tipo recibido.
   * @returns El mismo tipo, o `unknown` si no pertenece al vocabulario.
   *
   * @example
   * ```ts
   * this.normalizeEventType(WEBHOOK_PROVIDER_ENUM.DIDIT, 'ses_123'); // 'unknown'
   * ```
   */
  private normalizeEventType(
    provider: WEBHOOK_PROVIDER_ENUM,
    eventType: string,
  ): string {
    if (
      eventType === WEBHOOK_UNVERIFIED_EVENT_TYPE ||
      eventType === WEBHOOK_INVALID_PAYLOAD_EVENT_TYPE
    ) {
      return eventType;
    }

    const known =
      provider === WEBHOOK_PROVIDER_ENUM.DIDIT
        ? DIDIT_EVENT_TYPES.has(eventType)
        : eventType.length <= STRIPE_EVENT_TYPE_MAX_LENGTH &&
          STRIPE_EVENT_TYPE_PATTERN.test(eventType);

    return known ? eventType : WEBHOOK_UNKNOWN_EVENT_TYPE;
  }

  /**
   * Ejecuta una emisión de métricas sin dejar escapar sus errores. Con las métricas apagadas no
   * hace nada.
   *
   * @param emit - Emisión.
   * @returns Nada.
   *
   * @example
   * ```ts
   * this.safely(() => this.dispatchTotal.inc({ provider, target }));
   * ```
   */
  private safely(emit: () => void): void {
    if (!this.isEnabled()) return;

    try {
      emit();
    } catch (error) {
      this.logger.error(
        'No se pudo emitir una métrica de webhooks.',
        error instanceof Error ? error.stack : undefined,
      );
    }
  }
}
