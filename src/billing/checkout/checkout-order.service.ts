import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
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
   * Una orden siempre apunta a un único `catalog_price`; el item de esa oferta decide qué se
   * compra, sin columnas polimórficas para plan y paquetes.
   */
  async registerPendingSubscription(input: {
    billingProfileId: string;
    catalogPriceId: string;
    stripeCheckoutSessionId: string;
    amount: number;
    currency: string;
  }): Promise<CheckoutOrderEntity> {
    const order = await this.checkoutOrderRepository.save(
      this.checkoutOrderRepository.create({
        billingProfileId: input.billingProfileId,
        catalogPriceId: input.catalogPriceId,
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
   * mismo `checkout.session.completed` no mueve `completed_at` —que dejaría de ser la fecha real
   * del pago— ni pisa los ids de Stripe ya grabados.
   *
   * No lanza si no encuentra la orden: la sesión pudo crearse fuera de este flujo, y su efecto
   * importante —vincular el perfil con el cliente y la suscripción— ya ocurrió.
   */
  async markCompleted(input: {
    stripeCheckoutSessionId: string;
    stripePaymentIntentId: string | null;
    stripeSubscriptionId: string | null;
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
        stripeSubscriptionId: input.stripeSubscriptionId,
      },
    );

    if (!result.affected) {
      this.logger.warn(
        `checkout.session.completed para la sesión ${input.stripeCheckoutSessionId} sin ninguna ` +
          'orden PENDING que cerrar (ya cerrada por una entrega anterior, o abierta fuera de este flujo).',
      );
    }
  }

  /**
   * Conecta la orden de alta con el slot que la primera factura de la suscripción emitió.
   * Se invoca al crear el slot, por lo que cubre el orden normal: Checkout → invoice.paid.
   */
  async linkCompletedSubscriptionToCreditSlot(input: {
    billingProfileId: string;
    stripeSubscriptionId: string | null;
    creditSlotId: string;
  }): Promise<void> {
    if (!input.stripeSubscriptionId) {
      return;
    }

    await this.checkoutOrderRepository.update(
      {
        billingProfileId: input.billingProfileId,
        stripeSubscriptionId: input.stripeSubscriptionId,
        kind: CHECKOUT_KIND_ENUM.SUBSCRIPTION,
        status: CHECKOUT_ORDER_STATUS_ENUM.COMPLETED,
        creditSlotId: IsNull(),
      },
      { creditSlotId: input.creditSlotId },
    );
  }

  /**
   * Cubre el orden inverso: `invoice.paid` pudo crear el slot antes de que llegara Checkout.
   * Actualiza sólo esa sesión y nunca reemplaza un vínculo que ya existía.
   */
  async linkCheckoutSessionToCreditSlot(input: {
    stripeCheckoutSessionId: string;
    creditSlotId: string;
  }): Promise<void> {
    await this.checkoutOrderRepository.update(
      {
        stripeCheckoutSessionId: input.stripeCheckoutSessionId,
        status: CHECKOUT_ORDER_STATUS_ENUM.COMPLETED,
        creditSlotId: IsNull(),
      },
      { creditSlotId: input.creditSlotId },
    );
  }
}
