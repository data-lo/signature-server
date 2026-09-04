import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { frontendBaseUrl } from 'src/shared/utils/frontend-url.util';
import { StripePaymentService } from 'src/payments/stripe/stripe-payment.service';
import { BillingOwnerService } from '../profiles/billing-owner.service';
import { BillingCatalogService } from '../catalog/billing-catalog.service';
import { BillingProfileEntity } from '../profiles/billing-profile.entity';
import { BILLING_PROFILE_STATUS_ENUM } from '../enums/billing-profile-status.enum';
import { ActiveSubscriptionAlreadyExistsException } from '../exceptions/billing.exceptions';
import { CheckoutOrderService } from './checkout-order.service';

const SUCCESS_PATH =
  '/dashboard/subscriptions?payment=success&session_id={CHECKOUT_SESSION_ID}';
const CANCEL_PATH = '/dashboard/subscriptions?payment=cancel';

export interface SubscriptionCheckoutResponse {
  checkoutUrl: string;
}

@Injectable()
export class CreateSubscriptionCheckoutUseCase {
  private readonly logger = new Logger(CreateSubscriptionCheckoutUseCase.name);

  constructor(
    @InjectRepository(BillingProfileEntity)
    private readonly billingProfileRepository: Repository<BillingProfileEntity>,
    private readonly billingOwnerService: BillingOwnerService,
    private readonly billingCatalogService: BillingCatalogService,
    private readonly checkoutOrderService: CheckoutOrderService,
    private readonly paymentGateway: StripePaymentService,
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

    /**
     * Antes de tocar el catálogo y, sobre todo, antes de hablar con Stripe: el perfil es el
     * mismo para toda la organización, así que esto también corta al segundo miembro que
     * intenta contratar lo que la organización ya tiene.
     */
    if (profile.status === BILLING_PROFILE_STATUS_ENUM.ACTIVE) {
      this.logger.warn(
        `Checkout de suscripción rechazado: el perfil ${profile.id} ya está ACTIVE.`,
      );

      throw new ActiveSubscriptionAlreadyExistsException();
    }

    const catalogPrice =
      await this.billingCatalogService.findSellableRecurringPrice(
        input.priceId,
        owner,
      );
    const plan = catalogPrice.catalogItem.plan;
    if (!plan) {
      // findSellableRecurringPrice ya lo descarta; mantiene el tipo seguro si cambia la consulta.
      throw new Error(`El precio ${input.priceId} no tiene un plan asociado.`);
    }

    const customerId = await this.resolveCustomerId(profile, input.email);
    const frontendUrl = frontendBaseUrl();

    const { sessionId, checkoutUrl } =
      await this.paymentGateway.createCheckoutSession({
        priceId: catalogPrice.stripePriceId as string,
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
          planType: plan.planType,
          catalogPriceId: catalogPrice.id,
          accountId: input.accountId,
        },
      });

    await this.checkoutOrderService.registerPendingSubscription({
      billingProfileId: profile.id,
      catalogPriceId: catalogPrice.id,
      stripeCheckoutSessionId: sessionId,
      amount: catalogPrice.amount,
      currency: catalogPrice.currency,
    });

    this.logger.log(
      `Checkout de suscripción abierto para el perfil ${profile.id} (plan ${plan.planType}).`,
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
