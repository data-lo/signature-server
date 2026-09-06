import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { BillingProfileEntity } from '../profiles/billing-profile.entity';
import { PlanEntity } from '../catalog/plan.entity';
import { BILLING_SOURCE_ENUM } from '../enums/billing-source.enum';
import { SUBSCRIPTION_BILLING_HISTORY_STATUS_ENUM } from '../enums/subscription-billing-history-status.enum';
import { SUBSCRIPTION_END_REASON_ENUM } from '../enums/subscription-end-reason.enum';

/**
 * Un renglón por periodo de suscripción: qué plan cubrió, entre qué fechas y cómo terminó.
 *
 * **Existe porque `billing_profiles` sólo sabe el presente.** El perfil representa el estado
 * VIGENTE —un plan, un periodo— y cada cambio lo pisa. Eso bastaba mientras un perfil dado de
 * baja se quedaba en `CANCELED` recordando su último plan, pero desde que el término definitivo
 * lo devuelve al plan gratuito (`FinalizeSubscriptionFromStripeUseCase`), el perfil deja de poder
 * responder qué tenía contratado antes. Esta tabla es la que lo conserva.
 *
 * **Por eso el plan del renglón no se reescribe nunca con `free`.** El perfil vuelve a Free; el
 * historial guarda el plan que el cliente PAGÓ, que es lo que hace falta para explicar un cobro,
 * atender una aclaración o contar cuánta gente se fue de qué plan.
 *
 * `status`, `ended_at` y `ended_reason` describen el cierre y no el cobro: un periodo cerrado se
 * pagó igual de bien que uno vigente. Los tres se escriben juntos —lo impone
 * `CHK_subscription_billing_history_ended`— porque un cierre sin fecha o sin motivo es un renglón
 * que nadie sabe contar después.
 */
@Entity('subscription_billing_history')
@Index('IDX_subscription_billing_history_profile', [
  'billingProfileId',
  'periodStart',
])
/**
 * La llave de reconciliación del webhook.
 *
 * `customer.subscription.deleted` puede llegar varias veces —Stripe reintenta— y también puede
 * llegar después de un `customer.subscription.updated` que ya cerró lo mismo. Buscar por
 * suscripción es lo que permite reconocer "esto ya está registrado" en vez de abrir un segundo
 * renglón para el mismo periodo. No es único: un cliente que contrata, se va y vuelve genera
 * suscripciones distintas, y una misma suscripción puede dejar varios periodos si se renovó.
 */
@Index('IDX_subscription_billing_history_stripe_subscription', [
  'stripeSubscriptionId',
])
/**
 * El historial registra periodos FACTURADOS, y el plan gratuito no factura: `free` es un plan
 * legítimo del perfil pero nunca de esta tabla. La regla vive en la base porque un `INSERT` de
 * corrección hecho a mano no pasa por el caso de uso que la respeta.
 */
@Check(
  'CHK_subscription_billing_history_plan',
  `"plan_type" IS NULL OR "plan_type" <> 'free'`,
)
/**
 * Cerrado significa cerrado: un periodo terminado tiene que decir CUÁNDO y POR QUÉ, y uno vigente
 * no puede afirmar que ya terminó. Sin esta comprobación, una actualización a medias dejaría
 * filas que el historial no sabría interpretar.
 */
@Check(
  'CHK_subscription_billing_history_ended',
  `("status" = 'ACTIVE' AND "ended_at" IS NULL AND "ended_reason" IS NULL)
   OR ("status" <> 'ACTIVE' AND "ended_at" IS NOT NULL AND "ended_reason" IS NOT NULL)`,
)
export class SubscriptionBillingHistoryEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'billing_profile_id' })
  billingProfileId: string;

  @ManyToOne(() => BillingProfileEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'billing_profile_id' })
  billingProfile: BillingProfileEntity;

  /**
   * El plan que cubría ESTE periodo, no el que el perfil tenga hoy.
   *
   * Nullable porque el renglón puede nacer al cerrar una suscripción cuyo perfil no llegó a
   * registrar plan —una corrección manual, un alta a medias—. Perder el nombre del plan es
   * asumible; perder el registro del cierre no, así que la fila entra igual. Por el mismo motivo
   * el `ON DELETE SET NULL`: retirar un plan del catálogo no puede quedar bloqueado por
   * facturación vieja.
   */
  @Column({ name: 'plan_type', type: 'varchar', length: 64, nullable: true })
  planType: string | null;

  @ManyToOne(() => PlanEntity, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'plan_type', referencedColumnName: 'planType' })
  plan: PlanEntity | null;

  /**
   * `enumName` explícito porque el tipo no se llama como TypeORM lo derivaría de la tabla y la
   * columna (`subscription_billing_history_source_enum`): el origen de un cobro es un concepto de
   * facturación y no de esta tabla en concreto, así que el tipo lleva su propio nombre. Sin esto,
   * un `migration:generate` posterior propondría recrear la columna sin motivo.
   */
  @Column({
    type: 'enum',
    enum: BILLING_SOURCE_ENUM,
    enumName: 'billing_source_enum',
    default: BILLING_SOURCE_ENUM.STRIPE,
  })
  source: BILLING_SOURCE_ENUM;

  @Column({
    type: 'enum',
    enum: SUBSCRIPTION_BILLING_HISTORY_STATUS_ENUM,
    default: SUBSCRIPTION_BILLING_HISTORY_STATUS_ENUM.ACTIVE,
  })
  status: SUBSCRIPTION_BILLING_HISTORY_STATUS_ENUM;

  @Column({ name: 'period_start', type: 'timestamptz', nullable: true })
  periodStart: Date | null;

  @Column({ name: 'period_end', type: 'timestamptz', nullable: true })
  periodEnd: Date | null;

  /**
   * Cuándo confirmó Stripe el término. **No es lo mismo que `period_end`**: una baja inmediata o
   * una por impago cortan antes de que el periodo llegue a su fin, y el corte de caja necesita la
   * fecha real, no la que estaba prevista.
   */
  @Column({ name: 'ended_at', type: 'timestamptz', nullable: true })
  endedAt: Date | null;

  /** `enumName` explícito, por el mismo motivo que en `source`. */
  @Column({
    name: 'ended_reason',
    type: 'enum',
    enum: SUBSCRIPTION_END_REASON_ENUM,
    enumName: 'subscription_end_reason_enum',
    nullable: true,
  })
  endedReason: SUBSCRIPTION_END_REASON_ENUM | null;

  /**
   * Los identificadores del proveedor se guardan en el renglón y no sólo en el perfil: el perfil
   * los pisa en cuanto el cliente vuelve a contratar, y entonces ya no habría forma de saber qué
   * suscripción de Stripe corresponde a qué periodo. Son la referencia con la que se audita un
   * cobro meses después.
   */
  @Column({ name: 'stripe_customer_id', nullable: true })
  stripeCustomerId: string | null;

  @Column({ name: 'stripe_subscription_id', nullable: true })
  stripeSubscriptionId: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
