import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { frontendBaseUrl } from 'src/shared/utils/frontend-url.util';
import { StripePaymentGatewayService } from 'src/payments/stripe/stripe-payment-gateway.service';
import { BillingOwnerService } from '../profiles/billing-owner.service';
import { BillingCatalogService } from '../catalog/billing-catalog.service';
import { BillingProfileEntity } from '../profiles/billing-profile.entity';
import { CheckoutOrderService } from './checkout-order.service';

/**
 * A dónde vuelve el usuario cuando Stripe termina. `{CHECKOUT_SESSION_ID}` lo sustituye Stripe al
 * redirigir; sirve para acusar recibo en la pantalla, no para dar el pago por bueno — quien
 * confirma la suscripción es el webhook firmado.
 */
const SUCCESS_PATH =
  '/dashboard/subscriptions?payment=success&session_id={CHECKOUT_SESSION_ID}';
const CANCEL_PATH = '/dashboard/subscriptions?payment=cancel';

export interface SubscriptionCheckoutResponse {
  checkoutUrl: string;
}

/**
 * Abre una sesión de Checkout recurrente para el propietario facturable de la cuenta activa y
 * deja registrada la orden pendiente.
 *
 * El orden de los pasos importa y no es casual: la orden se registra DESPUÉS de que Stripe
 * devuelve la sesión, porque su `stripe_checkout_session_id` es NOT NULL y único — es justamente
 * la llave con la que el webhook la vuelve a encontrar. Registrarla antes obligaría a inventar un
 * identificador provisional y a limpiarlo si Stripe fallara.
 *
 * Este caso de uso NO concede documentos ni activa nada: aquí sólo se abre la puerta al pago. La
 * activación económica ocurre en `invoice.paid` (ver `SubscriptionBillingService`), con el dinero
 * ya cobrado.
 */
@Injectable()
export class CreateSubscriptionCheckoutUseCase {
  private readonly logger = new Logger(CreateSubscriptionCheckoutUseCase.name);

  constructor(
    @InjectRepository(BillingProfileEntity)
    private readonly billingProfileRepository: Repository<BillingProfileEntity>,
    private readonly billingOwnerService: BillingOwnerService,
    private readonly billingCatalogService: BillingCatalogService,
    private readonly checkoutOrderService: CheckoutOrderService,
    private readonly paymentGateway: StripePaymentGatewayService,
  ) {}

  async execute(input: {
    userId: string;
    email: string;
    accountId: string;
    priceId: string;
  }): Promise<SubscriptionCheckoutResponse> {
    const owner = await this.billingOwnerService.resolveOwner(
      input.userId,
      input.accountId,
    );
    const profile = await this.billingOwnerService.getOrCreateProfile(owner);

    const planPrice = await this.billingCatalogService.findSellableRecurringPrice(
      input.priceId,
    );

    const customerId = await this.resolveCustomerId(profile, input.email);
    const frontendUrl = frontendBaseUrl();

    const { sessionId, checkoutUrl } =
      await this.paymentGateway.createCheckoutSession({
        priceId: planPrice.stripePriceId,
        mode: 'subscription',
        customerId,
        successUrl: `${frontendUrl}${SUCCESS_PATH}`,
        cancelUrl: `${frontendUrl}${CANCEL_PATH}`,
        /**
         * `billingProfileId` es lo que permite reconciliar `checkout.session.completed` sin
         * depender del cliente de Stripe. `accountId` se conserva por compatibilidad con el
         * flujo anterior (`StripeWebhookService.handleCheckoutSessionCompleted`, que sigue
         * manteniendo `account_subscriptions`).
         */
        metadata: {
          billingProfileId: profile.id,
          planCode: planPrice.planCode,
          planPriceId: planPrice.id,
          accountId: input.accountId,
        },
      });

    await this.checkoutOrderService.registerPendingSubscription({
      billingProfileId: profile.id,
      planPriceId: planPrice.id,
      stripeCheckoutSessionId: sessionId,
      amount: planPrice.amount,
      currency: planPrice.currency,
    });

    this.logger.log(
      `Checkout de suscripción abierto para el perfil ${profile.id} (plan ${planPrice.planCode}).`,
    );

    return { checkoutUrl };
  }

  /**
   * Un perfil tiene un solo cliente en Stripe, creado la primera vez que intenta pagar. Si se
   * creara uno por sesión, el historial de facturación del mismo propietario quedaría repartido
   * entre clientes distintos y los eventos de renovación no podrían reconciliarse por cliente.
   */
  private async resolveCustomerId(
    profile: BillingProfileEntity,
    email: string,
  ): Promise<string> {
    if (profile.stripeCustomerId) {
      return profile.stripeCustomerId;
    }

    const customerId = await this.paymentGateway.createCustomer(
      profile.id,
      email,
    );

    await this.billingProfileRepository.update(profile.id, {
      stripeCustomerId: customerId,
    });
    profile.stripeCustomerId = customerId;

    return customerId;
  }
}
