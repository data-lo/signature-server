import { Injectable, Logger } from '@nestjs/common';
import { frontendBaseUrl } from 'src/common/utils/frontend-url.util';
import { StripePaymentService } from 'src/payments/stripe/stripe-payment.service';
import { BillingOwnerService } from '../profiles/billing-owner.service';
import { StripeCustomerService } from '../profiles/stripe-customer.service';
import { BillingCatalogService } from '../catalog/billing-catalog.service';
import { BILLING_PROFILE_STATUS_ENUM } from '../enums/billing-profile-status.enum';
import { ActiveSubscriptionAlreadyExistsException } from '../exceptions/billing.exceptions';
import { CheckoutOrderService } from './checkout-order.service';

const SUCCESS_PATH =
  '/dashboard/subscriptions?payment=success&session_id={CHECKOUT_SESSION_ID}';
const CANCEL_PATH = '/dashboard/subscriptions?payment=cancel';

export interface SubscriptionCheckoutResponse {
  /** URL hospedada de Stripe, temporal: se pide al comprar y no se guarda. */
  checkoutUrl: string;
}

export interface SubscriptionCheckoutInput {
  userId: string;
  /** Correo del comprador; identifica al cliente en Stripe la primera vez que paga. */
  email: string;
  /** Cuenta activa (`X-Account-Id`): decide a QUÉ propietario facturable se le contrata. */
  accountId: string;
  /** `price_...` del catálogo; se valida contra `catalog_prices` antes de usarse. */
  priceId: string;
}

/**
 * Abre una sesión de Stripe Checkout para contratar un plan.
 *
 * @remarks
 * Flujo:
 *
 * 1. Resuelve el propietario facturable desde el usuario y la cuenta activa, y obtiene o crea su
 *    `billing_profile`.
 * 2. Rechaza si el perfil ya está `ACTIVE`. Se comprueba antes de tocar el catálogo y antes de
 *    hablar con Stripe: el perfil es el mismo para toda la organización, así que esto también
 *    corta al segundo miembro que intenta contratar lo que la organización ya tiene.
 * 3. Valida el precio contra el catálogo local: activo, recurrente, con plan vigente y dentro del
 *    alcance del propietario.
 * 4. Resuelve el cliente de Stripe del perfil, creándolo si es su primer pago.
 * 5. Crea la sesión en modo `subscription` con la metadata de reconciliación.
 * 6. Registra la orden en `PENDING` antes de devolver la URL.
 *
 * La orden se escribe ANTES de mandar al usuario a Stripe: si se registrara al volver, un pago
 * cuyo navegador nunca regresó quedaría cobrado y sin rastro local que reconciliar.
 *
 * El importe que se cobra sale del catálogo local y no de lo que el proveedor conteste en ese
 * instante, para que cada cobro tenga detrás una fila nuestra, versionada y auditable.
 *
 * Aquí NO se activa nada: la suscripción queda pendiente hasta que el webhook `invoice.paid`
 * confirme el cobro.
 */
@Injectable()
export class CreateSubscriptionCheckoutUseCase {
  private readonly logger = new Logger(CreateSubscriptionCheckoutUseCase.name);

  constructor(
    private readonly billingOwnerService: BillingOwnerService,
    private readonly stripeCustomerService: StripeCustomerService,
    private readonly billingCatalogService: BillingCatalogService,
    private readonly checkoutOrderService: CheckoutOrderService,
    private readonly paymentGateway: StripePaymentService,
  ) {}

  /**
   * Ejecuta el caso de uso.
   *
   * @param input Usuario que contrata, su correo, la cuenta activa y el precio del catálogo.
   * @returns La URL de Checkout a la que hay que mandar el navegador.
   * @throws {ActiveSubscriptionAlreadyExistsException} Cuando el perfil ya tiene una suscripción
   *   vigente; se responde 409 para que el frontend mande al portal de facturación en vez de a
   *   pagar otra vez.
   * @throws {SubscriptionPriceNotAvailableException} Cuando el precio no existe, está dado de
   *   baja, no es recurrente o queda fuera del alcance del propietario.
   * @throws {ForbiddenException} Cuando el usuario no pertenece a la cuenta activa.
   */
  async execute(
    input: SubscriptionCheckoutInput,
  ): Promise<SubscriptionCheckoutResponse> {
    const owner = await this.billingOwnerService.resolveOwner(
      input.userId,
      input.accountId,
    );
    const profile = await this.billingOwnerService.getOrCreateProfile(owner);

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

    const customerId = await this.stripeCustomerService.resolveForProfile(
      profile,
      input.email,
    );
    const frontendUrl = frontendBaseUrl();

    const { sessionId, checkoutUrl } =
      await this.paymentGateway.createCheckoutSession({
        priceId: catalogPrice.stripePriceId as string,
        mode: 'subscription',
        customerId,
        successUrl: `${frontendUrl}${SUCCESS_PATH}`,
        cancelUrl: `${frontendUrl}${CANCEL_PATH}`,
        // `accountId` lo sigue necesitando el flujo heredado de `account_subscriptions`.
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
}
