import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import Stripe = require('stripe');
import { StripeWebhookService } from 'src/stripe/stripe-webhook.service';
import { StripeWebhookSignatureVerifierService } from '../stripe/stripe-webhook-signature-verifier.service';
import { RegisterWebhookEventUseCase } from './register-webhook-event.use-case';
import { WEBHOOK_PROVIDER_ENUM } from '../enums/webhook-provider.enum';
import { WebhookReceptionResult } from '../interfaces/webhook-reception-result.interface';

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
  ) {}

  async execute(
    input: ReceiveStripeWebhookInput,
  ): Promise<WebhookReceptionResult> {
    // `constructEvent` verifica y parsea de una sola vez: si esto devuelve un evento, el cuerpo
    // salió de Stripe. No hay camino en el que se lea el payload sin haber validado la firma.
    const stripeEvent: Stripe.Event | null = this.signatureVerifier.verify(
      input.rawBody,
      input.signature,
    );

    if (!stripeEvent) {
      await this.registerWebhookEvent.recordRejectedDelivery(
        WEBHOOK_PROVIDER_ENUM.STRIPE,
        'Firma de Stripe inválida o ausente',
      );
      throw new UnauthorizedException('Firma de Stripe inválida');
    }

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
      return { received: true, duplicate: true };
    }

    try {
      await this.stripeWebhookService.process(stripeEvent);
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

    await this.registerWebhookEvent.markProcessed(event.id);
    return { received: true, duplicate: false };
  }
}
