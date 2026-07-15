import { PLAN_ID_ENUM } from '../enums/plan-id.enum';
import { SUBSCRIPTION_STATUS_ENUM } from '../enums/subscription-status.enum';

export interface UserSubscriptionState {
  hasActiveSubscription: boolean;
  planId: PLAN_ID_ENUM | null;
  status: SUBSCRIPTION_STATUS_ENUM | null;
  currentPeriodEnd: Date | null;
}
