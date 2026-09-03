import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import Stripe = require('stripe');
import { AccountSubscriptionEntity } from '../entities/account-subscription.entity';
import { SUBSCRIPTION_STATUS_ENUM } from '../enums/subscription-status.enum';
import { PLAN_ID_ENUM } from '../enums/plan-id.enum';
import { CatalogSyncService } from '../../billing/catalog/catalog-sync.service';
import { StripePaymentGatewayService } from './stripe-payment-gateway.service';
import { SubscriptionBillingService } from '../../billing/subscriptions/subscription-billing.service';

/**
 * Router de los eventos de Stripe ya autenticados. Cada evento soportado tiene su propio handler
 * — para reaccionar a uno nuevo basta con agregar un case al switch de `process()`.
 *
 * **Conviven dos modelos de suscripción y los dos se atienden aquí.** Los handlers privados
 * mantienen `account_subscriptions`, el modelo anterior, del que todavía dependen
 * `GetSubscriptionStateUseCase` y la pantalla de suscripciones del frontend. Los servicios de
 * `billing` mantienen el modelo nuevo (`billing_profiles` + `credit_lots`), que además concede el
 * saldo de documentos. Se invocan los dos por evento, en ese orden, hasta que el modelo viejo se
 * retire: quitarlo ahora dejaría esa pantalla sin datos.
 *
 * Los efectos de `billing` van DESPUÉS del handler heredado a propósito. Si el nuevo falla, el
 * evento se propaga y Stripe reintenta la entrega completa; que el efecto heredado se haya
 * aplicado antes no estorba, porque todos los handlers de este archivo son idempotentes.
 */
@Injectable()
export class StripeWebhookService {
  private readonly logger = new Logger(StripeWebhookService.name);

  constructor(
    @InjectRepository(AccountSubscriptionEntity)
    private readonly subscriptionRepository: Repository<AccountSubscriptionEntity>,
    private readonly catalogSyncService: CatalogSyncService,
    private readonly paymentGateway: StripePaymentGatewayService,
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
      case 'product.updated':
        await this.catalogSyncService.syncProductUpserted(
          event.data.object as Stripe.Product,
        );
        break;
      case 'product.deleted':
        await this.catalogSyncService.syncProductDeleted(
          event.data.object as Stripe.Product,
        );
        break;
      /**
       * `price.created` y `price.updated` mantienen `plan_prices` y `document_pack_offers`.
       *
       * `plan.created` NO se maneja: es el objeto heredado que Stripe reemplazó por `price`, y
       * atenderlo duplicaría cada alta de precio en el catálogo local.
       */
      case 'price.created':
      case 'price.updated': {
        const price = event.data.object as Stripe.Price;
        await this.catalogSyncService.syncPriceUpserted(
          price,
          await this.resolvePriceProduct(price),
        );
        break;
      }
      default:
        this.logger.log(`Evento de Stripe sin manejar: ${event.type}`);
    }
  }

  /**
   * El producto del precio, que es donde vive la metadata que enruta el evento. En el payload de
   * un webhook `product` llega como id (Stripe no expande nada en los eventos), así que hay que
   * ir a buscarlo; si alguna vez llegara ya expandido, se usa tal cual y se ahorra la llamada.
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
   * Bug corregido: Stripe no garantiza el orden entre `checkout.session.completed` (que es
   * quien primero graba `stripeSubscriptionId` en la fila local, ver `handleCheckoutSessionCompleted`)
   * e `invoice.paid`/`customer.subscription.deleted`. Si `invoice.paid` llega primero, la fila
   * local todavía tiene `stripeSubscriptionId = NULL` aunque el evento sí traiga uno — antes,
   * la búsqueda por `stripeSubscriptionId` fallaba y el método se rendía ahí mismo sin probar
   * `stripeCustomerId` (que sí coincide, porque `stripeCustomerId` se graba desde la creación
   * del checkout), dejando la suscripción atascada en INCOMPLETE para siempre. Ahora cae al
   * fallback por `stripeCustomerId` cuando la primera búsqueda no encuentra nada, no solo
   * cuando `stripeSubscriptionId` viene vacío.
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
