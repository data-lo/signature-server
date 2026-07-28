import { ConfigService } from '@nestjs/config';
import { PLAN_ID_ENUM } from '../enums/plan-id.enum';
import { PlanDetails } from '../interfaces/plan-details.interface';

/**
 * Mapea cada plan interno a su price_id de Stripe. Único punto que debe
 * cambiar al lanzar los planes comerciales finales (junto con la copia
 * visual en el frontend) — el resto del módulo de Stripe no debe tocarse.
 */
export function getPlansConfig(config: ConfigService): PlanDetails[] {
  return [
    {
      id: PLAN_ID_ENUM.BASIC,
      priceId: config.get<string>('STRIPE_PRICE_ID_BASIC'),
    },
    {
      id: PLAN_ID_ENUM.PRO,
      priceId: config.get<string>('STRIPE_PRICE_ID_PRO'),
    },
    {
      id: PLAN_ID_ENUM.ENTERPRISE,
      priceId: config.get<string>('STRIPE_PRICE_ID_ENTERPRISE'),
    },
  ];
}
