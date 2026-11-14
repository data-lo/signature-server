import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import Stripe = require('stripe');
import {
  StripeWebhookProcessResult,
  StripeWebhookService,
} from 'src/payments/stripe/stripe-webhook.service';
import { StripeWebhookSignatureVerifierService } from '../stripe/stripe-webhook-signature-verifier.service';
import { RegisterWebhookEventUseCase } from './register-webhook-event.use-case';
import { WEBHOOK_PROVIDER_ENUM } from '../enums/webhook-provider.enum';
import { WebhookReceptionResult } from '../interfaces/webhook-reception-result.interface';
import {
  WEBHOOK_UNVERIFIED_EVENT_TYPE,
  WebhookDeliveryOutcome,
  WebhookMetricsService,
} from 'src/metrics/webhook-metrics.service';

/** Destino de `webhook_dispatch_total` de un evento de Stripe que un handler atendió. */
const STRIPE_DISPATCH_TARGET = 'payments';

interface ReceiveStripeWebhookInput {
  rawBody: Buffer | undefined;
  signature: string | undefined;
}

/**
 * Orquesta una entrega de Stripe: autenticar → registrar → delegar → cerrar el estado.
 *
 * Qué significa `invoice.paid` para una suscripción es asunto de `StripeWebhookService`, en el
 * módulo `stripe`. Acá sólo vive la mecánica de la entrega.
 */
@Injectable()
export class ReceiveStripeWebhookUseCase {
  private readonly logger = new Logger(ReceiveStripeWebhookUseCase.name);

  constructor(
    private readonly signatureVerifier: StripeWebhookSignatureVerifierService,
    private readonly registerWebhookEvent: RegisterWebhookEventUseCase,
    private readonly stripeWebhookService: StripeWebhookService,
    private readonly webhookMetrics: WebhookMetricsService,
  ) {}

  /**
   * Atiende una entrega de Stripe y registra su resultado en las métricas.
   *
   * Un evento no soportado se marca PROCESSED y responde 200, igual que antes: Stripe no debe
   * reintentarlo. En las métricas queda como `ignored`.
   *
   * @param input - Cuerpo crudo y firma de la entrega.
   * @returns El acuse para Stripe, indicando si era un duplicado.
   *
   * @throws {UnauthorizedException} Si la firma no verifica.
   * @throws {Error} Lo que lance el dominio o la base, para responder 5xx y que Stripe reintente.
   *
   * @example
   * ```ts
   * await useCase.execute({ rawBody, signature });
   * ```
   */
  async execute(
    input: ReceiveStripeWebhookInput,
  ): Promise<WebhookReceptionResult> {
    const startedAt = performance.now();
    let eventType = WEBHOOK_UNVERIFIED_EVENT_TYPE;
    // `failed` hasta demostrar lo contrario: así un error de la base al registrar o al cerrar el
    // estado, que también responde 5xx, cuenta como fallo sin necesidad de un `catch` por paso.
    let outcome: WebhookDeliveryOutcome = 'failed';

    try {
      // `constructEvent` verifica y parsea de una sola vez: si esto devuelve un evento, el cuerpo
      // salió de Stripe. No hay camino en el que se lea el payload sin haber validado la firma.
      const stripeEvent: Stripe.Event | null = this.signatureVerifier.verify(
        input.rawBody,
        input.signature,
      );
      this.webhookMetrics.recordSignatureVerification(
        WEBHOOK_PROVIDER_ENUM.STRIPE,
        Boolean(stripeEvent),
      );

      if (!stripeEvent) {
        outcome = 'rejected';
        await this.registerWebhookEvent.recordRejectedDelivery(
          WEBHOOK_PROVIDER_ENUM.STRIPE,
          'Firma de Stripe inválida o ausente',
        );
        throw new UnauthorizedException('Firma de Stripe inválida');
      }

      eventType = stripeEvent.type;

      const { event, alreadyProcessed } =
        await this.registerWebhookEvent.register({
          provider: WEBHOOK_PROVIDER_ENUM.STRIPE,
          // Stripe garantiza que `evt_...` es estable entre reintentos de la misma entrega:
          // es exactamente la clave de idempotencia que la tabla necesita.
          providerEventId: stripeEvent.id,
          eventType: stripeEvent.type,
          payload: stripeEvent as unknown as Record<string, unknown>,
        });

      if (alreadyProcessed) {
        outcome = 'duplicate';
        return { received: true, duplicate: true };
      }

      let result: StripeWebhookProcessResult;

      try {
        result = await this.stripeWebhookService.process(stripeEvent);
      } catch (error) {
        await this.registerWebhookEvent.markFailed(event.id, error);
        this.logger.error(
          `Falló el procesamiento del webhook de Stripe ${stripeEvent.id} (${stripeEvent.type}).`,
          error instanceof Error ? error.stack : undefined,
        );
        // 5xx a propósito: Stripe reintenta con backoff durante varios días, y la fila en FAILED
        // guarda el motivo del intento anterior para poder diagnosticarlo.
        throw error;
      }

      this.webhookMetrics.recordDispatch(
        WEBHOOK_PROVIDER_ENUM.STRIPE,
        result === 'ignored' ? 'ignored' : STRIPE_DISPATCH_TARGET,
      );

      await this.registerWebhookEvent.markProcessed(event.id);
      outcome = result === 'ignored' ? 'ignored' : 'processed';
      return { received: true, duplicate: false };
    } finally {
      this.webhookMetrics.recordDelivery({
        provider: WEBHOOK_PROVIDER_ENUM.STRIPE,
        eventType,
        outcome,
        durationSeconds: (performance.now() - startedAt) / 1000,
      });
    }
  }
}
