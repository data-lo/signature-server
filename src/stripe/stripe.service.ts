import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import Stripe = require('stripe');
import { AccountEntity } from 'src/account/entities/account.entity';
import { AccountSubscriptionEntity } from './entities/account-subscription.entity';
import { PLAN_ID_ENUM } from './enums/plan-id.enum';
import { SUBSCRIPTION_STATUS_ENUM } from './enums/subscription-status.enum';
import { getPlansConfig } from './config/plans.config';
import { PlanDetails } from './interfaces/plan-details.interface';
import { StripeCheckoutResponse } from './interfaces/stripe-checkout-response.interface';
import { UserSubscriptionState } from './interfaces/user-subscription-state.interface';

@Injectable()
export class StripeService {
  readonly client: Stripe;
  private readonly plans: PlanDetails[];

  constructor(
    private readonly configService: ConfigService,
    @InjectRepository(AccountSubscriptionEntity)
    private readonly subscriptionRepository: Repository<AccountSubscriptionEntity>,
    @InjectRepository(AccountEntity)
    private readonly accountRepository: Repository<AccountEntity>,
  ) {
    this.client = new Stripe(
      this.configService.get<string>('STRIPE_SECRET_KEY'),
    );
    this.plans = getPlansConfig(this.configService);
  }

  getPlans(): PlanDetails[] {
    return this.plans;
  }

  /**
   * Resuelve la cuenta activa del usuario para efectos de facturación. Tras la fusión
   * Account/AccountMember (ver plan de migración ER-V2, Fase 5), `membership.id` ES el
   * identificador de contexto (antes era `membership.accountId`, apuntando al tenant
   * compartido). Simplificación conocida: sigue sin distinguir cuenta PERSONAL vs
   * ORGANIZATION al elegir cuál usar si el usuario tiene varias — mismo comportamiento
   * pre-existente, no una regresión de esta migración.
   */
  async resolveAccountId(userId: string): Promise<string> {
    const membership = await this.accountRepository.findOne({
      where: { userId, isActive: true },
    });

    if (!membership) {
      throw new NotFoundException(
        'El usuario no pertenece a ninguna cuenta activa',
      );
    }

    return membership.id;
  }

  async createCheckoutSession(
    accountId: string,
    email: string,
    planId: PLAN_ID_ENUM,
  ): Promise<StripeCheckoutResponse> {
    const plan = this.plans.find((p) => p.id === planId);
    if (!plan) {
      throw new NotFoundException(`Plan "${planId}" no encontrado`);
    }

    const subscription = await this.getOrCreateSubscriptionRecord(accountId);
    const customerId =
      subscription.stripeCustomerId ??
      (await this.createCustomer(accountId, email));

    if (!subscription.stripeCustomerId) {
      await this.subscriptionRepository.update(subscription.id, {
        stripeCustomerId: customerId,
      });
    }

    const frontendUrl = this.configService.get<string>('FRONTEND_URL');

    const session = await this.client.checkout.sessions.create(
      {
        mode: 'subscription',
        customer: customerId,
        line_items: [{ price: plan.priceId, quantity: 1 }],
        metadata: { accountId, planId },
        subscription_data: {
          metadata: { accountId, planId },
        },
        success_url: `${frontendUrl}/dashboard/plans/success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${frontendUrl}/dashboard/plans/cancel`,
      },
      {
        // Colapsa clics repetidos del mismo intento de suscripción en la misma sesión de
        // Checkout en vez de crear una nueva en Stripe por cada click; expira sola al día
        // siguiente, permitiendo un intento nuevo si el usuario vuelve a suscribirse.
        idempotencyKey: `checkout-session-${accountId}-${planId}-${new Date().toISOString().slice(0, 10)}`,
      },
    );

    return { sessionId: session.id, url: session.url };
  }

  async getSubscriptionState(
    accountId: string,
  ): Promise<UserSubscriptionState> {
    const subscription = await this.subscriptionRepository.findOne({
      where: { accountId },
    });

    if (!subscription) {
      return {
        hasActiveSubscription: false,
        planId: null,
        status: null,
        currentPeriodEnd: null,
      };
    }

    return {
      hasActiveSubscription: subscription.signingEnabled,
      planId: subscription.planId,
      status: subscription.status,
      currentPeriodEnd: subscription.currentPeriodEnd,
    };
  }

  private async createCustomer(
    accountId: string,
    email: string,
  ): Promise<string> {
    const customer = await this.client.customers.create({
      email,
      metadata: { accountId },
    });
    return customer.id;
  }

  private async getOrCreateSubscriptionRecord(
    accountId: string,
  ): Promise<AccountSubscriptionEntity> {
    const existing = await this.subscriptionRepository.findOne({
      where: { accountId },
    });
    if (existing) {
      return existing;
    }

    const created = this.subscriptionRepository.create({
      accountId,
      status: SUBSCRIPTION_STATUS_ENUM.INCOMPLETE,
      signingEnabled: false,
    });
    return this.subscriptionRepository.save(created);
  }
}
