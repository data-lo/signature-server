import { Injectable, Logger } from '@nestjs/common';
import { frontendBaseUrl } from 'src/common/utils/frontend-url.util';
import { StripePaymentService } from 'src/payments/stripe/stripe-payment.service';
import { BillingOwnerService } from '../profiles/billing-owner.service';
import { StripeCustomerService } from '../profiles/stripe-customer.service';
import { BillingCatalogService } from '../catalog/billing-catalog.service';
import { DocumentCreditOfferNotAvailableException } from '../exceptions/billing.exceptions';
import { assertValidDocumentCreditQuantity } from '../credits/document-credit-quantity';
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
  /**
   * Unidades de la oferta que se compran, elegidas en el frontend.
   *
   * También es un dato del cliente: se valida aquí (entero, de 1 a
   * `MAX_DOCUMENT_CREDITS_PER_PURCHASE`) y lo único que hace es multiplicar el precio que sale del
   * catálogo. Desde fuera nunca llega un importe ni un número de créditos.
   */
  quantity: number;
}

/**
 * Abre una sesión de Stripe Checkout para comprar documentos sueltos, en la cantidad elegida.
 *
 * @remarks
 * Flujo:
 *
 * 1. Valida la cantidad —entero entre 1 y `MAX_DOCUMENT_CREDITS_PER_PURCHASE`— antes de tocar la
 *    base o Stripe: una cantidad inválida no merece ni una consulta.
 * 2. Resuelve el propietario facturable desde el usuario y la cuenta activa, y obtiene o crea su
 *    `billing_profile`.
 * 3. Rechaza si el perfil no tiene plan vigente: sin plan no hay tarifa contra la que comparar.
 * 4. Valida el precio contra el catálogo local: activo, de tipo `DOCUMENT_CREDIT`, de pago único,
 *    con `eligible_plan_type` igual al plan del perfil, vigente y dentro del alcance.
 * 5. Calcula el importe esperado: precio unitario de `catalog_prices` × cantidad.
 * 6. Resuelve el cliente de Stripe del perfil, creándolo si es su primer pago.
 * 7. Crea la sesión en modo `payment` con UNA línea —el Price de la oferta por `quantity`, con la
 *    cantidad bloqueada— y la metadata de reconciliación (`billingProfileId`, `catalogPriceId`,
 *    `catalogItemId`, `quantity`, `accountId`).
 * 8. Registra la orden `ADD_ON` en `PENDING`, con la cantidad y el importe total, antes de devolver
 *    la URL.
 *
 * **Un solo Price sirve para cualquier cantidad.** No se crea un producto ni un precio en Stripe
 * por cada cantidad: se cobra `quantity` veces el Price de la oferta, y `adjustable_quantity`
 * queda apagado para que el cliente no pueda cambiar en Checkout lo que el servidor ya validó.
 *
 * **La cantidad de aquí no es la que se acredita.** El webhook vuelve a leer de Stripe cuántas
 * unidades se pagaron de verdad y las concilia con esta orden antes de emitir un solo crédito (ver
 * `RegisterDocumentCreditPurchaseUseCase`).
 *
 * **No toca la suscripción**, y ésa es la diferencia con `CreateSubscriptionCheckoutUseCase`: no
 * cambia el plan del perfil ni su estado, y por lo mismo NO rechaza a quien ya tiene una
 * suscripción activa ni a quien tiene la baja programada — comprar documentos de más es
 * justamente lo que hace alguien con plan vigente.
 *
 * La validación del paso 4 es la que impide comprar el paquete de otro plan manipulando el
 * `catalogPriceId`, y se repite aunque el frontend haya pedido antes la lista: entre listar y
 * comprar puede cambiar el catálogo.
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
   * Abre el Checkout de `quantity` unidades de una oferta de documentos y registra su orden.
   *
   * @param input - Usuario que compra, su correo, la cuenta activa, el precio del catálogo local y
   *   las unidades que quiere comprar.
   * @returns La URL de Checkout a la que hay que mandar el navegador.
   *
   * @throws {InvalidDocumentCreditQuantityException} Si la cantidad no es un entero, es menor que
   *   1 o supera `MAX_DOCUMENT_CREDITS_PER_PURCHASE`. Responde con `field: 'quantity'`.
   * @throws {DocumentCreditOfferNotAvailableException} Cuando la oferta no existe, está inactiva,
   *   no es un paquete de pago único, es de otro plan, no está publicada en Stripe, o la cuenta
   *   no tiene plan vigente. Es un error único para todas esas causas: distinguirlas le diría a
   *   quien manipula el `catalogPriceId` qué probar a continuación.
   * @throws {ForbiddenException} Cuando el usuario no pertenece a la cuenta activa.
   *
   * @example
   * ```ts
   * const { checkoutUrl } = await useCase.execute({
   *   userId: user.sub,
   *   email: user.email,
   *   accountId,
   *   catalogPriceId: '7f3c1f6e-2b4a-4c8d-9e15-0a1b2c3d4e5f',
   *   quantity: 5,
   * });
   * ```
   */
  async execute(
    input: DocumentCreditCheckoutInput,
  ): Promise<DocumentCreditCheckoutResponse> {
    assertValidDocumentCreditQuantity(input.quantity);

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

    // El precio unitario sale SIEMPRE del catálogo; la cantidad sólo lo multiplica.
    const expectedAmount = catalogPrice.amount * input.quantity;

    const customerId = await this.stripeCustomerService.resolveForProfile(
      profile,
      input.email,
    );
    const frontendUrl = frontendBaseUrl();

    const { sessionId, checkoutUrl } =
      await this.paymentGateway.createCheckoutSession({
        priceId: catalogPrice.stripePriceId,
        quantity: input.quantity,
        mode: 'payment',
        customerId,
        successUrl: `${frontendUrl}${SUCCESS_PATH}`,
        cancelUrl: `${frontendUrl}${CANCEL_PATH}`,
        metadata: {
          billingProfileId: profile.id,
          catalogPriceId: catalogPrice.id,
          catalogItemId: catalogPrice.catalogItemId,
          // La metadata de Stripe sólo admite cadenas.
          quantity: String(input.quantity),
          accountId: input.accountId,
        },
      });

    await this.checkoutOrderService.registerPendingDocumentCredits({
      billingProfileId: profile.id,
      catalogPriceId: catalogPrice.id,
      stripeCheckoutSessionId: sessionId,
      quantity: input.quantity,
      amount: expectedAmount,
      currency: catalogPrice.currency,
    });

    this.logger.log(
      `Checkout de créditos abierto para el perfil ${profile.id}: ${input.quantity} × ` +
        `${catalogPrice.catalogItem.documentCreditPack?.documentsGranted} documento(s) por ` +
        `${expectedAmount} ${catalogPrice.currency}, plan ${profile.currentPlanType}.`,
    );

    return { checkoutUrl };
  }
}
