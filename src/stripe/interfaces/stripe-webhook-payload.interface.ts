import { PLAN_ID_ENUM } from '../enums/plan-id.enum';

/**
 * Forma normalizada que StripeWebhookService extrae de un Stripe.Event crudo
 * antes de aplicar el cambio de estado sobre AccountSubscriptionEntity.
 */
export interface StripeWebhookPayload {
  eventType: string;
  accountId: string | null;
  planId: PLAN_ID_ENUM | null;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  currentPeriodEnd: Date | null;
}
