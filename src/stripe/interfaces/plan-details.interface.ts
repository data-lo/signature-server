import { PLAN_ID_ENUM } from '../enums/plan-id.enum';

export interface PlanDetails {
  id: PLAN_ID_ENUM;
  priceId: string;
}
