import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import Stripe = require('stripe');
import { BillingProfileEntity } from '../profiles/billing-profile.entity';
import { CreditLotEntity } from '../credits/credit-lot.entity';
import { BillingCatalogService } from '../catalog/billing-catalog.service';
import { CheckoutOrderService } from '../checkout/checkout-order.service';
import { RegisterSubscriptionBillingUseCase } from './register-subscription-billing.use-case';
import { BILLING_PROFILE_STATUS_ENUM } from '../enums/billing-profile-status.enum';
import { BILLING_SOURCE_ENUM } from '../enums/billing-source.enum';
import { CREDIT_LOT_ORIGIN_ENUM } from '../enums/credit-lot-origin.enum';
import { PlanNotFoundForInvoiceException } from '../exceptions/billing.exceptions';

/**
 * Traduce el estado de una suscripción de Stripe al del perfil local.
 *
 * `trialing` cae en ACTIVE a propósito: durante la prueba el cliente sí puede usar el servicio,
 * que es lo que este estado gobierna. `paused` cae en INCOMPLETE y no en CANCELED porque la
 * suscripción sigue existiendo y puede reanudarse.
 */
const STRIPE_STATUS_MAP: Record<
  Stripe.Subscription.Status,
  BILLING_PROFILE_STATUS_ENUM
> = {
  active: BILLING_PROFILE_STATUS_ENUM.ACTIVE,
  trialing: BILLING_PROFILE_STATUS_ENUM.ACTIVE,
  past_due: BILLING_PROFILE_STATUS_ENUM.PAST_DUE,
  unpaid: BILLING_PROFILE_STATUS_ENUM.PAST_DUE,
  canceled: BILLING_PROFILE_STATUS_ENUM.CANCELED,
  incomplete_expired: BILLING_PROFILE_STATUS_ENUM.CANCELED,
  incomplete: BILLING_PROFILE_STATUS_ENUM.INCOMPLETE,
  paused: BILLING_PROFILE_STATUS_ENUM.INCOMPLETE,
};

/**
 * Efectos de dominio de una suscripción recurrente: qué le pasa al perfil de facturación y al
 * saldo de documentos cuando Stripe informa de un cobro, un fallo o una cancelación.
 *
 * **La división del trabajo entre los dos eventos del alta es deliberada.**
 * `checkout.session.completed` sólo RELACIONA (guarda cliente, suscripción y plan, deja el perfil
 * en INCOMPLETE); `invoice.paid` es el que ACTIVA y concede documentos. Se separan porque una
 * sesión completada todavía no es dinero cobrado —un débito puede fallar después—, y conceder el
 * saldo ahí regalaría un mes de documentos a quien nunca llegó a pagar.
 *
 * **Nada aquí depende del orden de llegada.** Stripe no garantiza que
 * `checkout.session.completed` preceda a `invoice.paid`, así que el perfil se localiza por
 * suscripción y, si eso falla, por cliente (que se graba desde antes de abrir el checkout).
 */
/**
 * Estados desde los que `checkout.session.completed` puede dejar el perfil en INCOMPLETE.
 *
 * Son los que aún no representan una suscripción de pago: el plan gratuito con el que nace toda
 * cuenta, y un checkout anterior que tampoco llegó a cobrarse. Los demás (ACTIVE, PAST_DUE,
 * CANCELED) ya los mueve el cobro, y retrocederlos desde acá perdería lo que el webhook de la
 * factura ya confirmó.
 */
const ADMITE_CHECKOUT_PENDIENTE = new Set<BILLING_PROFILE_STATUS_ENUM>([
  BILLING_PROFILE_STATUS_ENUM.FREE,
  BILLING_PROFILE_STATUS_ENUM.INCOMPLETE,
]);

@Injectable()
export class SubscriptionBillingService {
  private readonly logger = new Logger(SubscriptionBillingService.name);

  constructor(
    @InjectRepository(BillingProfileEntity)
    private readonly billingProfileRepository: Repository<BillingProfileEntity>,
    @InjectRepository(CreditLotEntity)
    private readonly creditLotRepository: Repository<CreditLotEntity>,
    private readonly billingCatalogService: BillingCatalogService,
    private readonly checkoutOrderService: CheckoutOrderService,
    private readonly registerSubscriptionBilling: RegisterSubscriptionBillingUseCase,
  ) {}

  /**
   * Relaciona el perfil con Stripe y cierra la orden. NO concede documentos todavía.
   */
  async handleCheckoutSessionCompleted(
    session: Stripe.Checkout.Session,
  ): Promise<void> {
    if (session.mode !== 'subscription') {
      return;
    }

    const billingProfileId = session.metadata?.billingProfileId;
    if (!billingProfileId) {
      // Sesión abierta fuera de este flujo (el checkout anterior de `payments`, o una prueba
      // desde el dashboard). El flujo viejo la sigue atendiendo por su cuenta.
      this.logger.debug(
        `checkout.session.completed sin metadata.billingProfileId (sesión ${session.id}); no es del flujo de suscripción de billing.`,
      );
      return;
    }

    const profile = await this.billingProfileRepository.findOne({
      where: { id: billingProfileId },
    });

    if (!profile) {
      this.logger.warn(
        `checkout.session.completed con billingProfileId ${billingProfileId} inexistente (sesión ${session.id}).`,
      );
      return;
    }

    const stripeSubscriptionId = this.toId(session.subscription);

    await this.billingProfileRepository.update(profile.id, {
      stripeCustomerId: this.toId(session.customer) ?? profile.stripeCustomerId,
      stripeSubscriptionId:
        stripeSubscriptionId ?? profile.stripeSubscriptionId,
      currentPlanType: session.metadata?.planType ?? profile.currentPlanType,
      /**
       * INCOMPLETE y no ACTIVE: la sesión terminó, pero la activación la da el cobro
       * (`invoice.paid`). Y sólo se avanza desde un estado que todavía no tiene suscripción de
       * pago: si `invoice.paid` ya llegó primero y dejó el perfil ACTIVE, esta entrega no puede
       * desactivarlo.
       *
       * `FREE` entra en esa condición desde que toda cuenta nace con su perfil gratuito. Antes
       * el perfil lo creaba `getOrCreateProfile` y llegaba acá ya en INCOMPLETE, así que esto
       * era un no-op que sólo lo preservaba; ahora llega en FREE y hay una transición REAL que
       * hacer. Sin ella el perfil se quedaría diciendo "plan gratuito" entre el fin del checkout
       * y el cobro, cuando lo cierto es que ya contrató y falta confirmar el pago.
       */
      ...(ADMITE_CHECKOUT_PENDIENTE.has(profile.status)
        ? { status: BILLING_PROFILE_STATUS_ENUM.INCOMPLETE }
        : {}),
    });

    await this.checkoutOrderService.markCompleted({
      stripeCheckoutSessionId: session.id,
      stripePaymentIntentId: this.toId(session.payment_intent),
      stripeSubscriptionId,
    });

    // Stripe no asegura el orden de los dos eventos de alta. Si invoice.paid llegó primero,
    // el slot ya existe y ahora podemos enlazar la sesión exacta que acaba de completarse.
    if (stripeSubscriptionId) {
      const existingSlot = await this.creditLotRepository.findOne({
        where: {
          billingProfileId: profile.id,
          stripeSubscriptionId,
          origin: CREDIT_LOT_ORIGIN_ENUM.CURRENT_PERIOD,
        },
        order: { createdAt: 'DESC' },
      });
      if (existingSlot) {
        await this.checkoutOrderService.linkCheckoutSessionToCreditSlot({
          stripeCheckoutSessionId: session.id,
          creditSlotId: existingSlot.id,
        });
      }
    }

    this.logger.log(
      `Perfil ${profile.id} vinculado a Stripe tras completarse la sesión ${session.id}.`,
    );
  }

  /**
   * Adaptador de `invoice.paid`: traduce lo que manda Stripe y delega el efecto económico en
   * `RegisterSubscriptionBillingUseCase`.
   *
   * **Acá no se emite saldo ni se escribe historial.** Eso vive en el caso de uso porque un cobro
   * manual tiene que producir exactamente lo mismo, y dos copias de esa lógica se separan a la
   * primera corrección. Lo propio de este método es lo que sólo Stripe sabe: dónde viene el
   * periodo, qué precio se cobró y con qué ids se rastrea.
   *
   * **Nada depende del orden de llegada.** Stripe no garantiza que `checkout.session.completed`
   * preceda a `invoice.paid` ni que `customer.subscription.updated` llegue antes, así que el
   * perfil se localiza por suscripción y, si eso falla, por cliente —que se graba desde antes de
   * abrir el checkout— y el plan y el periodo salen de la propia factura en vez de leerse del
   * perfil.
   */
  async handleInvoicePaid(invoice: Stripe.Invoice): Promise<void> {
    const stripeSubscriptionId = this.toId(
      invoice.parent?.subscription_details?.subscription,
    );
    const stripeCustomerId = this.toId(invoice.customer);

    /**
     * Sólo las facturas de suscripción llegan a este flujo. Un cobro suelto —un paquete de
     * documentos— no abre un periodo ni renueva un plan, y registrarlo como tal dejaría el perfil
     * diciendo que tiene una suscripción vigente que nadie contrató.
     */
    if (!stripeSubscriptionId) {
      this.logger.debug(
        `invoice.paid ${invoice.id} no corresponde a una suscripción; no abre periodo.`,
      );
      return;
    }

    const profile = await this.findProfile(
      stripeSubscriptionId,
      stripeCustomerId,
    );

    /**
     * **Se avisa y se devuelve 2xx en vez de fallar.** Un 5xx haría que Stripe reintentara la
     * entrega durante días, y ninguno de esos reintentos encontraría el perfil: si no está
     * vinculado ni por suscripción ni por cliente, el vínculo no aparece solo. Lo que arregla el
     * caso es una intervención humana, y para eso el warning lleva TODOS los ids con los que
     * buscar en Stripe y en la base. Reintentar sin parar sólo escondería el problema detrás de
     * una alerta de webhooks fallidos.
     */
    if (!profile) {
      this.logger.warn(
        'invoice.paid sin perfil de facturación asociado; el cobro queda sin acreditar. ' +
          `factura=${invoice.id ?? '(sin id)'} suscripción=${stripeSubscriptionId} ` +
          `cliente=${stripeCustomerId ?? '(sin id)'}`,
      );
      return;
    }

    const line = invoice.lines?.data?.[0];
    const stripePriceId = this.toId(line?.pricing?.price_details?.price);
    const planPrice = stripePriceId
      ? await this.billingCatalogService.findPriceForInvoice(stripePriceId)
      : null;

    /**
     * Ésta sí falla ruidosamente: hubo un cobro real y no sabemos cuántos documentos concede el
     * plan. A diferencia del perfil ausente, esto SÍ se arregla solo en cuanto el catálogo se
     * sincronice, así que los reintentos de Stripe trabajan a favor.
     */
    if (!planPrice?.catalogItem.plan) {
      throw new PlanNotFoundForInvoiceException(stripePriceId);
    }

    await this.registerSubscriptionBilling.execute({
      billingProfileId: profile.id,
      source: BILLING_SOURCE_ENUM.STRIPE,
      planType: planPrice.catalogItem.plan.planType,
      /**
       * `amount_paid` y no `total`: lo que de verdad entró. Difieren cuando la factura se liquida
       * en parte con saldo del cliente o con un cupón, y el historial tiene que cuadrar con el
       * dinero, no con lo que se pidió.
       */
      amount: invoice.amount_paid ?? invoice.total ?? 0,
      currency: invoice.currency,
      /**
       * El periodo vive en la LÍNEA de la factura, no en la suscripción. Stripe lo movió ahí en
       * la API de 2025: buscarlo en la suscripción —donde lo pone toda la documentación
       * anterior— devuelve `undefined` en silencio.
       */
      periodStart: this.toDate(line?.period?.start),
      periodEnd: this.toDate(line?.period?.end),
      paidAt: this.toDate(invoice.status_transitions?.paid_at) ?? new Date(),
      stripeCustomerId,
      stripeSubscriptionId,
      stripeInvoiceId: invoice.id ?? null,
      stripePaymentIntentId: this.toId(
        (invoice as { payment_intent?: string | { id: string } })
          .payment_intent,
      ),
    });
  }

  /**
   * Un cobro fallido deja el perfil en PAST_DUE y **no** emite documentos.
   *
   * No se tocan los lotes ya emitidos: lo que el cliente pagó en periodos anteriores es suyo, y
   * borrarlo por un impago posterior sería quitarle algo que sí compró. Lo que se le corta es la
   * renovación, que simplemente no ocurre.
   */
  async handleInvoicePaymentFailed(invoice: Stripe.Invoice): Promise<void> {
    const profile = await this.findProfile(
      this.toId(invoice.parent?.subscription_details?.subscription),
      this.toId(invoice.customer),
    );

    if (!profile) {
      this.logger.warn(
        `invoice.payment_failed sin perfil local asociado (factura ${invoice.id}).`,
      );
      return;
    }

    await this.billingProfileRepository.update(profile.id, {
      status: BILLING_PROFILE_STATUS_ENUM.PAST_DUE,
    });

    this.logger.warn(
      `Perfil ${profile.id} marcado PAST_DUE por la factura fallida ${invoice.id}.`,
    );
  }

  /** Sincroniza estado, plan vigente, id de suscripción y periodo. */
  async handleSubscriptionUpdated(
    subscription: Stripe.Subscription,
  ): Promise<void> {
    const profile = await this.findProfile(
      subscription.id,
      this.toId(subscription.customer),
    );

    if (!profile) {
      this.logger.warn(
        `customer.subscription.updated sin perfil local asociado (suscripción ${subscription.id}).`,
      );
      return;
    }

    const item = subscription.items?.data?.[0];
    const stripePriceId = this.toId(item?.price);
    const planPrice = stripePriceId
      ? await this.billingCatalogService.findPriceForInvoice(stripePriceId)
      : null;

    /**
     * El periodo vive en el ITEM, no en la suscripción. Stripe lo movió ahí en la API de 2025 y
     * `Stripe.Subscription` ya no expone `current_period_start/end`: buscarlos en la suscripción
     * (que es donde los pone toda la documentación anterior) da `undefined` en silencio y deja el
     * periodo del perfil sin actualizar, sin ningún error.
     */
    const periodStart = this.toDate(item?.current_period_start);
    const periodEnd = this.toDate(item?.current_period_end);

    await this.billingProfileRepository.update(profile.id, {
      status: this.toProfileStatus(subscription.status),
      stripeSubscriptionId: subscription.id,
      ...(planPrice?.catalogItem.plan
        ? { currentPlanType: planPrice.catalogItem.plan.planType }
        : {}),
      ...(periodStart ? { currentPeriodStart: periodStart } : {}),
      ...(periodEnd ? { currentPeriodEnd: periodEnd } : {}),
    });

    this.logger.log(
      `Perfil ${profile.id} sincronizado desde la suscripción ${subscription.id} (${subscription.status}).`,
    );
  }

  /**
   * Cancela el perfil sin tocar su historial: los lotes emitidos y los consumos registrados se
   * conservan tal cual. Son la evidencia de lo que el cliente pagó y gastó, y hacen falta para
   * responder una aclaración meses después de la baja.
   */
  async handleSubscriptionDeleted(
    subscription: Stripe.Subscription,
  ): Promise<void> {
    const profile = await this.findProfile(
      subscription.id,
      this.toId(subscription.customer),
    );

    if (!profile) {
      this.logger.warn(
        `customer.subscription.deleted sin perfil local asociado (suscripción ${subscription.id}).`,
      );
      return;
    }

    await this.billingProfileRepository.update(profile.id, {
      status: BILLING_PROFILE_STATUS_ENUM.CANCELED,
    });

    this.logger.log(
      `Perfil ${profile.id} CANCELED tras eliminarse la suscripción ${subscription.id}.`,
    );
  }

  /**
   * Busca primero por suscripción y cae al cliente si no la encuentra.
   *
   * El fallback es lo que hace el flujo independiente del orden de los eventos: el
   * `stripe_customer_id` se graba antes de abrir el checkout, mientras que el
   * `stripe_subscription_id` no existe hasta que la sesión se completa. Si `invoice.paid` llega
   * antes que `checkout.session.completed`, la búsqueda por suscripción no encuentra nada aunque
   * el evento sí traiga el id — y sin el fallback el cobro quedaría huérfano.
   */
  private async findProfile(
    stripeSubscriptionId: string | null,
    stripeCustomerId: string | null,
  ): Promise<BillingProfileEntity | null> {
    if (stripeSubscriptionId) {
      const bySubscription = await this.billingProfileRepository.findOne({
        where: { stripeSubscriptionId },
      });

      if (bySubscription) {
        return bySubscription;
      }
    }

    if (stripeCustomerId) {
      return this.billingProfileRepository.findOne({
        where: { stripeCustomerId },
      });
    }

    return null;
  }

  private toProfileStatus(
    status: Stripe.Subscription.Status,
  ): BILLING_PROFILE_STATUS_ENUM {
    return STRIPE_STATUS_MAP[status] ?? BILLING_PROFILE_STATUS_ENUM.INCOMPLETE;
  }

  /** Stripe entrega segundos desde epoch; `Date` espera milisegundos. */
  private toDate(seconds: number | null | undefined): Date | null {
    return typeof seconds === 'number' ? new Date(seconds * 1000) : null;
  }

  /** Un campo de Stripe llega como id suelto o como el objeto expandido, según la petición. */
  private toId(
    value: string | { id: string } | null | undefined,
  ): string | null {
    if (!value) {
      return null;
    }

    return typeof value === 'string' ? value : value.id;
  }
}
