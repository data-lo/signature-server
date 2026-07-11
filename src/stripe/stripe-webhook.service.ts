import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import Stripe = require('stripe');
import { AccountSubscriptionEntity } from './entities/account-subscription.entity';
import { SUBSCRIPTION_STATUS_ENUM } from './enums/subscription-status.enum';
import { PLAN_ID_ENUM } from './enums/plan-id.enum';

/**
 * Cada evento soportado tiene su propio handler privado — para reaccionar a
 * un evento nuevo de Stripe basta con agregar un case al switch de
 * `process()` y un método privado, sin tocar el resto del módulo.
 */
@Injectable()
export class StripeWebhookService {
  private readonly logger = new Logger(StripeWebhookService.name);

  constructor(
    @InjectRepository(AccountSubscriptionEntity)
    private readonly subscriptionRepository: Repository<AccountSubscriptionEntity>,
  ) {}

  async process(event: Stripe.Event): Promise<void> {
    switch (event.type) {
      case 'checkout.session.completed':
        await this.handleCheckoutSessionCompleted(event.data.object as Stripe.Checkout.Session);
        break;
      case 'invoice.paid':
        await this.handleInvoicePaid(event.data.object as Stripe.Invoice);
        break;
      case 'customer.subscription.deleted':
        await this.handleSubscriptionDeleted(event.data.object as Stripe.Subscription);
        break;
      default:
        this.logger.log(`Evento de Stripe sin manejar: ${event.type}`);
    }
  }

  private async handleCheckoutSessionCompleted(session: Stripe.Checkout.Session): Promise<void> {
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
    const stripeSubscriptionId = this.toId(invoice.parent?.subscription_details?.subscription);
    const currentPeriodEnd = invoice.lines.data[0]?.period?.end
      ? new Date(invoice.lines.data[0].period.end * 1000)
      : null;

    const subscription = await this.findByCustomerOrSubscription(stripeCustomerId, stripeSubscriptionId);
    if (!subscription) {
      this.logger.warn(`invoice.paid recibido sin AccountSubscriptionEntity asociada (customer ${stripeCustomerId})`);
      return;
    }

    await this.subscriptionRepository.update(subscription.id, {
      status: SUBSCRIPTION_STATUS_ENUM.ACTIVE,
      signingEnabled: true,
      stripeSubscriptionId: stripeSubscriptionId ?? subscription.stripeSubscriptionId,
      currentPeriodEnd,
    });
  }

  private async handleSubscriptionDeleted(subscription: Stripe.Subscription): Promise<void> {
    const record = await this.findByCustomerOrSubscription(this.toId(subscription.customer), subscription.id);
    if (!record) {
      this.logger.warn(`customer.subscription.deleted recibido sin AccountSubscriptionEntity asociada (subscription ${subscription.id})`);
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
    const existing = await this.subscriptionRepository.findOne({ where: { accountId } });

    if (existing) {
      await this.subscriptionRepository.update(existing.id, changes);
      return;
    }

    const created = this.subscriptionRepository.create({ accountId, signingEnabled: false, ...changes });
    await this.subscriptionRepository.save(created);
  }

  private findByCustomerOrSubscription(
    stripeCustomerId: string | null,
    stripeSubscriptionId: string | null,
  ): Promise<AccountSubscriptionEntity | null> {
    if (stripeSubscriptionId) {
      return this.subscriptionRepository.findOne({ where: { stripeSubscriptionId } });
    }
    if (stripeCustomerId) {
      return this.subscriptionRepository.findOne({ where: { stripeCustomerId } });
    }
    return Promise.resolve(null);
  }

  private toId(
    value: string | Stripe.Customer | Stripe.DeletedCustomer | Stripe.Subscription | null | undefined,
  ): string | null {
    if (!value) return null;
    return typeof value === 'string' ? value : value.id;
  }
}
