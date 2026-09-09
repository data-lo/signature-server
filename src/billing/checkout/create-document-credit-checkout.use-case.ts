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
 * espera cosas distintas en cada caso, y compartirlo haría que comprar documentos anunciara
 * "suscripción activa".
 */
const SUCCESS_PATH =
  '/dashboard/subscriptions?purchase=credits&session_id={CHECKOUT_SESSION_ID}';
const CANCEL_PATH = '/dashboard/subscriptions?purchase=cancel';

export interface DocumentCreditCheckoutResponse {
  /** URL hospedada de Stripe, temporal: se pide al comprar y no se guarda. */
  checkoutUrl: string;
}

export interface DocumentCreditCheckoutInput {
  userId: string;
  /** Correo del comprador; identifica al cliente en Stripe la primera vez que paga. */
  email: string;
  /** Cuenta activa (`X-Account-Id`): decide a QUÉ propietario facturable se le cobra. */
  accountId: string;
  /**
   * Id del precio en el catálogo LOCAL (`catalog_prices.id`), no el de Stripe.
   *
   * Llega del cliente y se trata como tal: el plan contra el que se valida sale del perfil
   * resuelto en el servidor, y el precio que se le pasa a Stripe sale de la fila del catálogo.
   */
  catalogPriceId: string;
}

/**
 * Abre una sesión de Stripe Checkout para comprar un paquete de documentos sueltos.
 *
 * @remarks
 * Flujo:
 *
 * 1. Resuelve el propietario facturable desde el usuario y la cuenta activa, y obtiene o crea su
 *    `billing_profile`.
 * 2. Rechaza si el perfil no tiene plan vigente: sin plan no hay tarifa contra la que comparar.
 * 3. Valida el precio contra el catálogo local: activo, de tipo `DOCUMENT_CREDIT`, de pago único,
 *    con `eligible_plan_type` igual al plan del perfil, vigente y dentro del alcance.
 * 4. Resuelve el cliente de Stripe del perfil, creándolo si es su primer pago.
 * 5. Crea la sesión en modo `payment` con la metadata de reconciliación
 *    (`billingProfileId`, `catalogPriceId`, `catalogItemId`, `accountId`).
 * 6. Registra la orden `ADD_ON` en `PENDING` antes de devolver la URL.
 *
 * **No toca la suscripción**, y ésa es la diferencia con `CreateSubscriptionCheckoutUseCase`: no
 * cambia el plan del perfil ni su estado, y por lo mismo NO rechaza a quien ya tiene una
 * suscripción activa ni a quien tiene la baja programada — comprar documentos de más es
 * justamente lo que hace alguien con plan vigente.
 *
 * La validación del paso 3 es la que impide comprar el paquete de otro plan manipulando el
 * `catalogPriceId`, y se repite aunque el frontend haya pedido antes la lista: entre listar y
 * comprar puede cambiar el catálogo.
 *
 * Aquí NO se acredita ningún documento: el saldo lo emite el webhook `checkout.session.completed`
 * (ver `RegisterDocumentCreditPurchaseUseCase`).
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
   * Ejecuta el caso de uso.
   *
   * @param input Usuario que compra, su correo, la cuenta activa y el precio del catálogo local.
   * @returns La URL de Checkout a la que hay que mandar el navegador.
   * @throws {DocumentCreditOfferNotAvailableException} Cuando la oferta no existe, está inactiva,
   *   no es un paquete de pago único, es de otro plan, no está publicada en Stripe, o la cuenta
   *   no tiene plan vigente. Es un error único para todas esas causas: distinguirlas le diría a
   *   quien manipula el `catalogPriceId` qué probar a continuación.
   * @throws {ForbiddenException} Cuando el usuario no pertenece a la cuenta activa.
   */
  async execute(
    input: DocumentCreditCheckoutInput,
  ): Promise<DocumentCreditCheckoutResponse> {
    const owner = await this.billingOwnerService.resolveOwner(
      input.userId,
      input.accountId,
    );
    const profile = await this.billingOwnerService.getOrCreateProfile(owner);

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

    // El catálogo admite importes sin publicar en Stripe; vendibles no son.
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
        mode: 'payment',
        customerId,
        successUrl: `${frontendUrl}${SUCCESS_PATH}`,
        cancelUrl: `${frontendUrl}${CANCEL_PATH}`,
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
