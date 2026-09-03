import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Stripe = require('stripe');
import { StripePaymentService } from 'src/payments/stripe/stripe-payment.service';

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
    /**
     * Se inyecta el gateway del módulo de pagos —no un cliente propio— para verificar con
     * EXACTAMENTE la misma configuración de Stripe con la que se crean las sesiones: dos
     * clientes distintos podrían quedar con versiones de API o llaves distintas y hacer que la
     * verificación fallara sin motivo aparente. `client` está expuesto justo para esto.
     */
    private readonly paymentGateway: StripePaymentService,
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
      return this.paymentGateway.client.webhooks.constructEvent(
        rawBody,
        signature,
        webhookSecret,
      );
    } catch {
      return null;
    }
  }
}
