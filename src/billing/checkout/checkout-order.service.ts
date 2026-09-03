import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CheckoutOrderEntity } from './checkout-order.entity';
import { CHECKOUT_KIND_ENUM } from '../enums/checkout-kind.enum';
import { CHECKOUT_ORDER_STATUS_ENUM } from '../enums/checkout-order-status.enum';

/**
 * Bitácora local de intentos de compra: una fila por sesión de Checkout abierta.
 *
 * Existe aparte de `billing_profiles` porque responde otra pregunta. El perfil dice en qué estado
 * está la suscripción AHORA; esto dice qué se intentó comprar, cuándo, por cuánto y si llegó a
 * completarse — incluyendo los intentos que el usuario abandonó, de los que el perfil no guarda
 * ni rastro. Es lo que permite reconciliar contra Stripe y responder "¿por qué le cobraron?".
 */
@Injectable()
export class CheckoutOrderService {
  private readonly logger = new Logger(CheckoutOrderService.name);

  constructor(
    @InjectRepository(CheckoutOrderEntity)
    private readonly checkoutOrderRepository: Repository<CheckoutOrderEntity>,
  ) {}

  /**
   * Registra la orden PENDING recién abierta contra Stripe.
   *
   * `documentPackOfferId` va explícitamente en NULL y `kind` en SUBSCRIPTION porque la tabla lo
   * exige: `CHK_checkout_orders_item_matches_kind` obliga a que una orden lleve exactamente uno
   * de los dos artículos, el precio de plan o la oferta de paquete, según su tipo.
   */
  async registerPendingSubscription(input: {
    billingProfileId: string;
    planPriceId: string;
    stripeCheckoutSessionId: string;
    amount: number;
    currency: string;
  }): Promise<CheckoutOrderEntity> {
    const order = await this.checkoutOrderRepository.save(
      this.checkoutOrderRepository.create({
        billingProfileId: input.billingProfileId,
        planPriceId: input.planPriceId,
        documentPackOfferId: null,
        kind: CHECKOUT_KIND_ENUM.SUBSCRIPTION,
        stripeCheckoutSessionId: input.stripeCheckoutSessionId,
        stripePaymentIntentId: null,
        status: CHECKOUT_ORDER_STATUS_ENUM.PENDING,
        amount: input.amount,
        currency: input.currency,
      }),
    );

    this.logger.log(
      `Orden ${order.id} registrada como PENDING para el perfil ${input.billingProfileId}.`,
    );

    return order;
  }

  /**
   * Cierra la orden cuando Stripe confirma que la sesión se completó.
   *
   * Es idempotente por diseño: el `WHERE` exige que siga en PENDING, así que una re-entrega del
   * mismo `checkout.session.completed` no mueve `completed_at` —que dejaría de ser la fecha real del
   * pago— ni pisa un `stripePaymentIntentId` ya grabado.
   *
   * No lanza si no encuentra la orden: la sesión pudo crearse fuera de este flujo, y su efecto
   * importante —vincular el perfil con el cliente y la suscripción— ya ocurrió.
   */
  async markCompleted(input: {
    stripeCheckoutSessionId: string;
    stripePaymentIntentId: string | null;
  }): Promise<void> {
    const result = await this.checkoutOrderRepository.update(
      {
        stripeCheckoutSessionId: input.stripeCheckoutSessionId,
        status: CHECKOUT_ORDER_STATUS_ENUM.PENDING,
      },
      {
        status: CHECKOUT_ORDER_STATUS_ENUM.COMPLETED,
        completedAt: new Date(),
        stripePaymentIntentId: input.stripePaymentIntentId,
      },
    );

    if (!result.affected) {
      this.logger.warn(
        `checkout.session.completed para la sesión ${input.stripeCheckoutSessionId} sin ninguna ` +
          'orden PENDING que cerrar (ya cerrada por una entrega anterior, o abierta fuera de este flujo).',
      );
    }
  }
}
