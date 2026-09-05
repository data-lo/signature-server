import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';
import Stripe = require('stripe');
import { BillingProfileEntity } from '../profiles/billing-profile.entity';
import { CreditLotEntity } from '../credits/credit-lot.entity';
import { BillingCatalogService } from '../catalog/billing-catalog.service';
import { CheckoutOrderService } from '../checkout/checkout-order.service';
import { BILLING_PROFILE_STATUS_ENUM } from '../enums/billing-profile-status.enum';
import { CREDIT_LOT_ORIGIN_ENUM } from '../enums/credit-lot-origin.enum';
import {
  BillingProfileNotFoundForInvoiceException,
  PlanNotFoundForInvoiceException,
} from '../exceptions/billing.exceptions';

/**
 * Prioridad del lote del periodo vigente. Mayor que la de un lote de arrastre para que el consumo
 * gaste primero lo que caduca antes — el sobrante arrastrado ya sobrevivió a un periodo y no
 * tiene por qué competir con lo recién emitido. (El consumo en sí está fuera del alcance de esta
 * historia; el número se fija aquí para que el orden ya quede escrito en los datos.)
 */
const CURRENT_PERIOD_LOT_PRIORITY = 100;

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
    @InjectDataSource() private readonly dataSource: DataSource,
    @InjectRepository(BillingProfileEntity)
    private readonly billingProfileRepository: Repository<BillingProfileEntity>,
    @InjectRepository(CreditLotEntity)
    private readonly creditLotRepository: Repository<CreditLotEntity>,
    private readonly billingCatalogService: BillingCatalogService,
    private readonly checkoutOrderService: CheckoutOrderService,
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
   * Activa el plan y emite el lote de documentos del periodo. Es el único punto donde se concede
   * saldo por una suscripción.
   *
   * Idempotente por `credit_lots.stripe_invoice_id`: la comprobación va DENTRO de la transacción
   * y después de bloquear el perfil, no antes. Comprobar fuera dejaría una ventana en la que dos
   * entregas simultáneas de la misma factura (Stripe reintenta, y un reintento puede solaparse
   * con el original) pasarían las dos la comprobación y emitirían dos lotes. Con el bloqueo, la
   * segunda espera a que la primera termine y entonces sí ve el lote ya emitido. El índice único
   * de la columna queda como última red.
   */
  async handleInvoicePaid(invoice: Stripe.Invoice): Promise<void> {
    const stripeSubscriptionId = this.toId(
      invoice.parent?.subscription_details?.subscription,
    );
    const stripeCustomerId = this.toId(invoice.customer);

    const profile = await this.findProfileForInvoice(
      stripeSubscriptionId,
      stripeCustomerId,
    );

    const line = invoice.lines?.data?.[0];
    const stripePriceId = this.toId(line?.pricing?.price_details?.price);
    const planPrice = stripePriceId
      ? await this.billingCatalogService.findPriceForInvoice(stripePriceId)
      : null;

    if (!planPrice?.catalogItem.plan) {
      throw new PlanNotFoundForInvoiceException(stripePriceId);
    }

    const periodStart = this.toDate(line?.period?.start);
    const periodEnd = this.toDate(line?.period?.end);

    await this.dataSource.transaction(async (manager) => {
      const locked = await manager.findOne(BillingProfileEntity, {
        where: { id: profile.id },
        lock: { mode: 'pessimistic_write' },
      });

      if (!locked) {
        throw new BillingProfileNotFoundForInvoiceException(
          `el perfil ${profile.id} desapareció durante la transacción`,
        );
      }

      const creditLotRepository = manager.getRepository(CreditLotEntity);

      if (invoice.id) {
        const alreadyIssued = await creditLotRepository.findOne({
          where: { stripeInvoiceId: invoice.id },
        });

        if (alreadyIssued) {
          this.logger.log(
            `invoice.paid ${invoice.id} ya tenía el lote ${alreadyIssued.id}; no se emite otro.`,
          );
          return;
        }
      }

      await this.rolloverPreviousPeriod(manager, locked.id);

      const issued = planPrice.catalogItem.plan.documentsIncluded;
      const lot = await creditLotRepository.save(
        creditLotRepository.create({
          billingProfileId: locked.id,
          origin: CREDIT_LOT_ORIGIN_ENUM.CURRENT_PERIOD,
          issued,
          remaining: issued,
          priority: CURRENT_PERIOD_LOT_PRIORITY,
          stripeInvoiceId: invoice.id ?? null,
          stripeSubscriptionId,
          periodStart,
          periodEnd,
        }),
      );

      await manager.update(BillingProfileEntity, locked.id, {
        status: BILLING_PROFILE_STATUS_ENUM.ACTIVE,
        currentPlanType: planPrice.catalogItem.plan.planType,
        stripeSubscriptionId:
          stripeSubscriptionId ?? locked.stripeSubscriptionId,
        currentPeriodStart: periodStart,
        currentPeriodEnd: periodEnd,
      });

      // Orden normal: Checkout ya guardó la suscripción. Vinculamos sólo la orden inicial que
      // aún no tenga slot; en renovaciones no hay una orden de Checkout nueva que tocar.
      await this.checkoutOrderService.linkCompletedSubscriptionToCreditSlot({
        billingProfileId: locked.id,
        stripeSubscriptionId,
        creditSlotId: lot.id,
      });

      this.logger.log(
        `Perfil ${locked.id} ACTIVE con el plan ${planPrice.catalogItem.plan.planType}; lote ${lot.id} de ${issued} documentos emitido por la factura ${invoice.id}.`,
      );
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
   * Convierte en ROLLOVER el saldo vigente que quede sin gastar.
   *
   * Sólo los lotes con `remaining > 0`, tal como pide la regla de negocio: un lote agotado no
   * arrastra nada y reetiquetarlo sólo ensuciaría el historial de cómo se consumió cada periodo.
   */
  private async rolloverPreviousPeriod(
    manager: EntityManager,
    billingProfileId: string,
  ): Promise<void> {
    const result = await manager
      .createQueryBuilder()
      .update(CreditLotEntity)
      .set({ origin: CREDIT_LOT_ORIGIN_ENUM.ROLLOVER })
      .where('billing_profile_id = :billingProfileId', { billingProfileId })
      .andWhere('origin = :origin', {
        origin: CREDIT_LOT_ORIGIN_ENUM.CURRENT_PERIOD,
      })
      .andWhere('remaining > 0')
      .execute();

    if (result.affected) {
      this.logger.log(
        `${result.affected} lote(s) del periodo anterior pasaron a ROLLOVER en el perfil ${billingProfileId}.`,
      );
    }
  }

  /** Igual que `findProfile`, pero exigiendo resultado: hubo un cobro y no se puede ignorar. */
  private async findProfileForInvoice(
    stripeSubscriptionId: string | null,
    stripeCustomerId: string | null,
  ): Promise<BillingProfileEntity> {
    const profile = await this.findProfile(
      stripeSubscriptionId,
      stripeCustomerId,
    );

    if (!profile) {
      throw new BillingProfileNotFoundForInvoiceException(
        `suscripción ${stripeSubscriptionId ?? '(ninguna)'} / cliente ${stripeCustomerId ?? '(ninguno)'}`,
      );
    }

    return profile;
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
