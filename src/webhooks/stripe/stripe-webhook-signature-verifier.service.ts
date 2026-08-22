import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Stripe = require('stripe');
import { StripeService } from 'src/stripe/stripe.service';

/**
 * Verifica la cabecera `stripe-signature` delegando en el SDK oficial.
 *
 * `constructEvent` hace tres cosas que no conviene reimplementar: recalcula el HMAC-SHA256 del
 * cuerpo crudo con el `whsec_...`, compara en tiempo constante y valida la marca de tiempo
 * incluida en la propia cabecera (defensa contra reenvío). Devuelve el evento ya tipado, así
 * que la verificación y el parseo son un solo paso — imposible procesar un cuerpo sin verificar.
 */
@Injectable()
export class StripeWebhookSignatureVerifierService {
  private readonly logger = new Logger(
    StripeWebhookSignatureVerifierService.name,
  );

  constructor(
    private readonly stripeService: StripeService,
    private readonly configService: ConfigService,
  ) {}

  /**
   * @returns El evento verificado, o `null` si la firma no es confiable. Nunca lanza: el caso
   *   de uso decide qué respuesta HTTP corresponde y si deja rastro de auditoría.
   */
  verify(
    rawBody: Buffer | undefined,
    signature: string | undefined,
  ): Stripe.Event | null {
    const webhookSecret = this.configService.get<string>(
      'STRIPE_WEBHOOK_SECRET',
    );

    if (!webhookSecret) {
      this.logger.error(
        'STRIPE_WEBHOOK_SECRET no está configurado: no es posible verificar webhooks de Stripe.',
      );
      return null;
    }

    if (!rawBody || !signature) {
      return null;
    }

    try {
      return this.stripeService.client.webhooks.constructEvent(
        rawBody,
        signature,
        webhookSecret,
      );
    } catch {
      return null;
    }
  }
}
