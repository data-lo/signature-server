import { Injectable, Logger } from '@nestjs/common';
import { frontendBaseUrl } from 'src/shared/utils/frontend-url.util';
import { StripePaymentService } from 'src/payments/stripe/stripe-payment.service';
import { BillingOwnerService } from '../profiles/billing-owner.service';
import { StripeCustomerService } from '../profiles/stripe-customer.service';
import { BillingCatalogService } from '../catalog/billing-catalog.service';
import { DocumentCreditOfferNotAvailableException } from '../exceptions/billing.exceptions';
import { CheckoutOrderService } from './checkout-order.service';

/**
 * El retorno usa `purchase=credits` y no el `payment=success` de la suscripción: la pantalla
 * espera cosas distintas en cada caso —allí que el plan se active, aquí que suba el saldo— y
 * compartir el parámetro haría que comprar documentos anunciara "suscripción activa".
 */
const SUCCESS_PATH =
  '/dashboard/subscriptions?purchase=credits&session_id={CHECKOUT_SESSION_ID}';
const CANCEL_PATH = '/dashboard/subscriptions?purchase=cancel';

export interface DocumentCreditCheckoutResponse {
  checkoutUrl: string;
}

/**
 * Abre el Checkout para comprar un paquete de documentos sueltos.
 *
 * **No toca la suscripción, y ésa es la diferencia con `CreateSubscriptionCheckoutUseCase`.** La
 * sesión va en modo `payment` (cobro único) en vez de `subscription`, no cambia el plan del
 * perfil ni su estado, y por lo mismo **no se rechaza a quien ya tiene una suscripción activa**:
 * comprar documentos de más es justamente lo que hace alguien con plan vigente. Tampoco se
 * rechaza a quien tiene la baja programada — su plan sigue activo hasta el fin del periodo y su
 * tarifa sigue siendo la de ese plan.
 *
 * **Todo se valida en el servidor.** El `catalogPriceId` llega del cliente y podría estar
 * manipulado, así que el plan contra el que se comprueba sale del perfil resuelto acá, y el
 * precio que se le pasa a Stripe sale de la fila del catálogo — nunca del cuerpo de la petición.
 */
@Injectable()
export class CreateDocumentCreditCheckoutUseCase {
  private readonly logger = new Logger(
    CreateDocumentCreditCheckoutUseCase.name,
  );

  constructor(
    private readonly billingOwnerService: BillingOwnerService,
    private readonly stripeCustomerService: StripeCustomerService,
    private readonly billingCatalogService: BillingCatalogService,
    private readonly checkoutOrderService: CheckoutOrderService,
    private readonly paymentGateway: StripePaymentService,
  ) {}

  /**
   * Valida la oferta, abre la sesión de Checkout y deja la orden en `PENDING`.
   *
   * @param input - Usuario autenticado, su correo, la cuenta activa y el precio del catálogo
   *   local que se quiere comprar.
   * @returns La URL hospedada de Stripe a la que hay que mandar al navegador.
   *
   * @throws {DocumentCreditOfferNotAvailableException} Si la oferta no existe, está inactiva, no
   *   es un paquete de pago único, es de otro plan, o la cuenta no tiene plan vigente.
   * @throws {ForbiddenException} Si el usuario no pertenece a la cuenta activa (lo lanza
   *   `BillingOwnerService.resolveOwner`).
   *
   * @example
   * const { checkoutUrl } = await useCase.execute({
   *   userId: user.sub,
   *   email: user.email,
   *   accountId,
   *   catalogPriceId: dto.catalogPriceId,
   * });
   */
  async execute(input: {
    userId: string;
    email: string;
    accountId: string;
    catalogPriceId: string;
  }): Promise<DocumentCreditCheckoutResponse> {
    const owner = await this.billingOwnerService.resolveOwner(
      input.userId,
      input.accountId,
    );
    const profile = await this.billingOwnerService.getOrCreateProfile(owner);

    /**
     * Sin plan vigente no hay tarifa contra la que comparar, así que ninguna oferta le
     * corresponde. Se responde lo mismo que ante un paquete de otro plan: desde esta cuenta, esa
     * oferta no existe.
     */
    if (!profile.currentPlanType) {
      this.logger.warn(
        `Compra de créditos rechazada: el perfil ${profile.id} no tiene plan vigente.`,
      );
      throw new DocumentCreditOfferNotAvailableException();
    }

    const catalogPrice =
      await this.billingCatalogService.findSellableDocumentCreditPrice(
        input.catalogPriceId,
        profile.currentPlanType,
        owner,
      );

    /**
     * `findSellableDocumentCreditPrice` no exige `stripe_price_id`: un importe puede
     * administrarse sólo en nuestra base. Pero sin él no hay nada que cobrarle a Stripe, y
     * llegar hasta aquí con ese precio significa que alguien pidió comprar una oferta que
     * `GetAvailableDocumentCreditOffersUseCase` ni siquiera lista.
     */
    if (!catalogPrice.stripePriceId) {
      this.logger.warn(
        `Compra de créditos rechazada: el precio ${catalogPrice.id} no está publicado en Stripe.`,
      );
      throw new DocumentCreditOfferNotAvailableException();
    }

    const customerId = await this.stripeCustomerService.resolveForProfile(
      profile,
      input.email,
    );
    const frontendUrl = frontendBaseUrl();

    const { sessionId, checkoutUrl } =
      await this.paymentGateway.createCheckoutSession({
        priceId: catalogPrice.stripePriceId,
        /** Cobro único: no crea suscripción ni la modifica. */
        mode: 'payment',
        customerId,
        successUrl: `${frontendUrl}${SUCCESS_PATH}`,
        cancelUrl: `${frontendUrl}${CANCEL_PATH}`,
        /**
         * Lo que hace reconciliable el pago sin volver a preguntarle nada a Stripe.
         * `catalogPriceId` y `catalogItemId` dicen QUÉ se compró —y por tanto cuántos documentos
         * acreditar— y `billingProfileId` a quién acreditárselos. `accountId` viaja por simetría
         * con el flujo de suscripción y para poder rastrear el pago hasta la cuenta que lo hizo.
         */
        metadata: {
          billingProfileId: profile.id,
          catalogPriceId: catalogPrice.id,
          catalogItemId: catalogPrice.catalogItemId,
          accountId: input.accountId,
        },
      });

    await this.checkoutOrderService.registerPendingDocumentCredits({
      billingProfileId: profile.id,
      catalogPriceId: catalogPrice.id,
      stripeCheckoutSessionId: sessionId,
      amount: catalogPrice.amount,
      currency: catalogPrice.currency,
    });

    this.logger.log(
      `Checkout de créditos abierto para el perfil ${profile.id}: ` +
        `${catalogPrice.catalogItem.documentCreditPack?.documentsGranted} documento(s), plan ${profile.currentPlanType}.`,
    );

    return { checkoutUrl };
  }
}
