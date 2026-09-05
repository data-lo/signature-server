import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import Stripe = require('stripe');
import { AccountSubscriptionEntity } from '../entities/account-subscription.entity';
import { SUBSCRIPTION_STATUS_ENUM } from '../enums/subscription-status.enum';
import { PLAN_ID_ENUM } from '../enums/plan-id.enum';
import { CatalogSyncService } from '../../billing/catalog/catalog-sync.service';
import { StripePaymentService } from './stripe-payment.service';
import { SubscriptionBillingService } from '../../billing/subscriptions/subscription-billing.service';

/**
 * Enruta los eventos de Stripe ya autenticados: cada evento soportado tiene su handler, y para
 * reaccionar a uno nuevo basta agregar un case al switch de `process()`.
 *
 * **Conviven dos modelos de suscripción y los dos se atienden acá.** Los handlers privados mantienen
 * `account_subscriptions`, el modelo anterior, del que todavía dependen `GetSubscriptionStateUseCase`
 * y la pantalla de suscripciones; los servicios de `billing` mantienen el nuevo
 * (`billing_profiles` + `credit_lots`), que además concede el saldo de documentos. Se invocan los
 * dos por evento hasta que el viejo se retire: quitarlo ahora dejaría esa pantalla sin datos.
 *
 * Los efectos de `billing` van DESPUÉS del handler heredado: si el nuevo falla, el evento se propaga
 * y Stripe reintenta la entrega completa, y que el heredado ya se hubiera aplicado no estorba porque
 * todos los handlers de este archivo son idempotentes.
 */
@Injectable()
export class StripeWebhookService {
  private readonly logger = new Logger(StripeWebhookService.name);

  constructor(
    @InjectRepository(AccountSubscriptionEntity)
    private readonly subscriptionRepository: Repository<AccountSubscriptionEntity>,
    private readonly catalogSyncService: CatalogSyncService,
    private readonly paymentGateway: StripePaymentService,
    private readonly subscriptionBillingService: SubscriptionBillingService,
  ) {}

  async process(event: Stripe.Event): Promise<void> {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session;
        await this.handleCheckoutSessionCompleted(session);
        await this.subscriptionBillingService.handleCheckoutSessionCompleted(
          session,
        );
        break;
      }
      case 'invoice.paid': {
        const invoice = event.data.object as Stripe.Invoice;
        await this.handleInvoicePaid(invoice);
        await this.subscriptionBillingService.handleInvoicePaid(invoice);
        break;
      }
      case 'invoice.payment_failed':
        await this.subscriptionBillingService.handleInvoicePaymentFailed(
          event.data.object as Stripe.Invoice,
        );
        break;
      case 'customer.subscription.updated':
        await this.subscriptionBillingService.handleSubscriptionUpdated(
          event.data.object as Stripe.Subscription,
        );
        break;
      case 'customer.subscription.deleted': {
        const subscription = event.data.object as Stripe.Subscription;
        await this.handleSubscriptionDeleted(subscription);
        await this.subscriptionBillingService.handleSubscriptionDeleted(
          subscription,
        );
        break;
      }
      case 'product.created':
      case 'product.updated': {
        const product = event.data.object as Stripe.Product;
        this.logger.log(
          `Webhook ${event.type} recibido para el producto ${product.id} (${product.name}).`,
        );
        await this.catalogSyncService.syncProductUpserted(
          product,
        );
        this.logger.log(
          `Producto ${product.id} sincronizado tras ${event.type}.`,
        );
        break;
      }
      case 'product.deleted':
        await this.catalogSyncService.syncProductDeleted(
          event.data.object as Stripe.Product,
        );
        break;
      /**
       * `price.created` y `price.updated` mantienen `catalog_prices` y aseguran el detalle del
       * ítem (plan o paquete de créditos) antes de registrar la oferta.
       *
       * `plan.created` NO se maneja: es el objeto heredado que Stripe reemplazó por `price`, y
       * atenderlo duplicaría cada alta de precio en el catálogo local.
       */
      case 'price.created':
      case 'price.updated': {
        const price = event.data.object as Stripe.Price;
        this.logger.log(
          `Webhook ${event.type} recibido para el precio ${price.id} (active=${price.active}).`,
        );
        await this.catalogSyncService.syncPriceUpserted(
          price,
          await this.resolvePriceProduct(price),
        );
        this.logger.log(
          `Precio ${price.id} sincronizado tras ${event.type}.`,
        );
        break;
      }
      default:
        this.logger.log(`Evento de Stripe sin manejar: ${event.type}`);
    }
  }

  /**
   * Resuelve el producto del precio, que es donde vive la metadata que enruta el evento. En el
   * payload de un webhook `product` llega como id, porque Stripe no expande nada en los eventos, así
   * que hay que ir a buscarlo; si alguna vez llegara expandido, se usa tal cual.
   */
  private async resolvePriceProduct(
    price: Stripe.Price,
  ): Promise<Stripe.Product> {
    if (typeof price.product !== 'string') {
      return price.product as Stripe.Product;
    }

    return this.paymentGateway.retrieveProduct(price.product);
  }

  private async handleCheckoutSessionCompleted(
    session: Stripe.Checkout.Session,
  ): Promise<void> {
    const accountId = session.metadata?.accountId;
    if (!accountId || session.mode !== 'subscription') {
      return;
    }

    const planId = session.metadata?.planId as PLAN_ID_ENUM | undefined;
    const stripeCustomerId = this.toId(session.customer);
    const stripeSubscriptionId = this.toId(session.subscription);

    await this.upsert(accountId, {
      planId: planId ?? null,
      stripeCustomerId,
      stripeSubscriptionId,
      status: SUBSCRIPTION_STATUS_ENUM.INCOMPLETE,
    });
  }

  private async handleInvoicePaid(invoice: Stripe.Invoice): Promise<void> {
    const stripeCustomerId = this.toId(invoice.customer);
    const stripeSubscriptionId = this.toId(
      invoice.parent?.subscription_details?.subscription,
    );
    const currentPeriodEnd = invoice.lines.data[0]?.period?.end
      ? new Date(invoice.lines.data[0].period.end * 1000)
      : null;

    const subscription = await this.findByCustomerOrSubscription(
      stripeCustomerId,
      stripeSubscriptionId,
    );
    if (!subscription) {
      this.logger.warn(
        `invoice.paid recibido sin AccountSubscriptionEntity asociada (customer ${stripeCustomerId})`,
      );
      return;
    }

    await this.subscriptionRepository.update(subscription.id, {
      status: SUBSCRIPTION_STATUS_ENUM.ACTIVE,
      signingEnabled: true,
      stripeSubscriptionId:
        stripeSubscriptionId ?? subscription.stripeSubscriptionId,
      currentPeriodEnd,
    });
  }

  private async handleSubscriptionDeleted(
    subscription: Stripe.Subscription,
  ): Promise<void> {
    const record = await this.findByCustomerOrSubscription(
      this.toId(subscription.customer),
      subscription.id,
    );
    if (!record) {
      this.logger.warn(
        `customer.subscription.deleted recibido sin AccountSubscriptionEntity asociada (subscription ${subscription.id})`,
      );
      return;
    }

    await this.subscriptionRepository.update(record.id, {
      status: SUBSCRIPTION_STATUS_ENUM.CANCELED,
      signingEnabled: false,
    });
  }

  private async upsert(
    accountId: string,
    changes: Partial<AccountSubscriptionEntity>,
  ): Promise<void> {
    const existing = await this.subscriptionRepository.findOne({
      where: { accountId },
    });

    if (existing) {
      await this.subscriptionRepository.update(existing.id, changes);
      return;
    }

    const created = this.subscriptionRepository.create({
      accountId,
      signingEnabled: false,
      ...changes,
    });
    await this.subscriptionRepository.save(created);
  }

  /**
   * Localiza la fila local por suscripción y, si no aparece, por cliente.
   *
   * Stripe no garantiza el orden entre `checkout.session.completed` —que es quien primero graba
   * `stripeSubscriptionId`— e `invoice.paid`/`customer.subscription.deleted`. Si `invoice.paid` llega
   * primero, la fila todavía tiene `stripeSubscriptionId = NULL` aunque el evento sí traiga uno:
   * rendirse ahí dejaba la suscripción atascada en INCOMPLETE para siempre. El fallback por
   * `stripeCustomerId` —que se graba desde la creación del checkout— entra cuando la primera
   * búsqueda no encuentra nada, no sólo cuando el id viene vacío.
   */
  private async findByCustomerOrSubscription(
    stripeCustomerId: string | null,
    stripeSubscriptionId: string | null,
  ): Promise<AccountSubscriptionEntity | null> {
    if (stripeSubscriptionId) {
      const bySubscription = await this.subscriptionRepository.findOne({
        where: { stripeSubscriptionId },
      });
      if (bySubscription) {
        return bySubscription;
      }
    }
    if (stripeCustomerId) {
      return this.subscriptionRepository.findOne({
        where: { stripeCustomerId },
      });
    }
    return null;
  }

  private toId(
    value:
      | string
      | Stripe.Customer
      | Stripe.DeletedCustomer
      | Stripe.Subscription
      | null
      | undefined,
  ): string | null {
    if (!value) return null;
    return typeof value === 'string' ? value : value.id;
  }
}
