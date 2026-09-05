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
import { BILLING_PERIOD_END_REASON_ENUM } from '../enums/billing-period-end-reason.enum';
import { SUBSCRIPTION_BILLING_HISTORY_STATUS_ENUM } from '../enums/subscription-billing-history-status.enum';

/**
 * Un renglón por PERIODO FACTURADO: qué plan cubría, entre qué fechas, quién lo facturó y cómo
 * terminó.
 *
 * **Por qué no basta con `billing_profiles`.** El perfil guarda un único periodo —el vigente— y
 * cada cobro lo pisa. Eso responde "¿qué tiene hoy este cliente?" pero no "¿desde cuándo?", "¿qué
 * pasó en marzo?" ni "¿este plan se lo cobró Stripe o se lo facturamos a mano?". El origen es el
 * dato que más se pierde: cuando el cron devuelve un perfil manual a Free, su `billing_source`
 * pasa a `FREE` y, sin esta tabla, no quedaría rastro de que alguna vez se le facturó a mano.
 *
 * **Es la fuente de verdad del cron, no un registro decorativo.** `ExpireManualSubscriptionsJob`
 * no vence un perfil sin encontrar acá su periodo vigente, y usa `period_end` de esta fila como
 * segunda comprobación de que nadie renovó antes de tiempo.
 *
 * `UQ_subscription_billing_history_active` —índice único PARCIAL sobre `billing_profile_id`
 * donde `status = 'ACTIVE'`— es la pieza que sostiene lo anterior: garantiza que "el periodo
 * vigente" sea una fila y no un conjunto que haya que desempatar. Quien abra un periodo nuevo
 * tiene que cerrar el anterior en la MISMA transacción, y dos entregas simultáneas del mismo
 * cobro no pueden dejar dos periodos vivos ni aunque se salten la comprobación en código.
 *
 * `stripe_invoice_id` único hace de red equivalente para el lado de Stripe: la misma factura no
 * puede abrir dos periodos. Es el mismo criterio que ya sigue `credit_lots.stripe_invoice_id`.
 */
@Entity('subscription_billing_history')
@Index('IDX_subscription_billing_history_profile', [
  'billingProfileId',
  'createdAt',
])
@Index('UQ_subscription_billing_history_active', ['billingProfileId'], {
  unique: true,
  where: `"status" = 'ACTIVE'`,
})
/**
 * El historial registra periodos que se FACTURARON, y el plan gratuito no factura: `FREE` es un
 * valor legítimo de `billing_profiles.billing_source` pero nunca de esta columna. La regla vive
 * en la base porque un `INSERT` de corrección hecho a mano no pasa por el código que la respeta.
 */
@Check(
  'CHK_subscription_billing_history_source',
  `"source" IN ('STRIPE', 'MANUAL')`,
)
/**
 * Cerrado significa cerrado: un periodo `EXPIRED` tiene que decir CUÁNDO y POR QUÉ dejó de
 * valer, y uno `ACTIVE` no puede afirmar que ya terminó. Sin esta comprobación, una actualización
 * a medias dejaría filas que el historial no sabría contar.
 */
@Check(
  'CHK_subscription_billing_history_ended',
  `("status" = 'ACTIVE' AND "ended_at" IS NULL AND "ended_reason" IS NULL)
   OR ("status" = 'EXPIRED' AND "ended_at" IS NOT NULL AND "ended_reason" IS NOT NULL)`,
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
   * El plan que cubría ESTE periodo, no el que el perfil tenga hoy. Se guarda aparte justamente
   * porque el del perfil cambia: un cliente que subió de `basic` a `plus` tiene que seguir
   * viendo `basic` en los meses que pagó como `basic`.
   *
   * `ON DELETE SET NULL` y no `RESTRICT`: retirar un plan del catálogo no puede quedar bloqueado
   * por facturas viejas, y perder el nombre del plan es menos grave que perder el periodo entero.
   */
  @Column({ name: 'plan_type', type: 'varchar', length: 64, nullable: true })
  planType: string | null;

  @ManyToOne(() => PlanEntity, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'plan_type', referencedColumnName: 'planType' })
  plan: PlanEntity | null;

  /** Sólo `STRIPE` o `MANUAL`; ver `CHK_subscription_billing_history_source`. */
  @Column({
    type: 'enum',
    enum: BILLING_SOURCE_ENUM,
    enumName: 'billing_source_enum',
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

  /**
   * Cuándo deja de valer este periodo. Para un periodo manual es la fecha que el cron compara
   * contra `NOW()`; nula sólo si el origen no la informó, en cuyo caso el cron no lo vence
   * (prefiere dejar servicio de más antes que quitarlo sin fecha que lo justifique).
   */
  @Column({ name: 'period_end', type: 'timestamptz', nullable: true })
  periodEnd: Date | null;

  /** Único: la misma factura de Stripe no puede abrir dos periodos. */
  @Column({ name: 'stripe_invoice_id', nullable: true, unique: true })
  stripeInvoiceId: string | null;

  @Column({ name: 'stripe_subscription_id', nullable: true })
  stripeSubscriptionId: string | null;

  @Column({ name: 'ended_at', type: 'timestamptz', nullable: true })
  endedAt: Date | null;

  /**
   * `enumName` explícito, igual que en `source`: sin él TypeORM nombraría el tipo
   * `subscription_billing_history_ended_reason_enum` a partir de la tabla y la columna, y no
   * coincidiría con el que crea la migración — un `migration:generate` posterior propondría
   * recrear la columna sin motivo.
   */
  @Column({
    name: 'ended_reason',
    type: 'enum',
    enum: BILLING_PERIOD_END_REASON_ENUM,
    enumName: 'billing_period_end_reason_enum',
    nullable: true,
  })
  endedReason: BILLING_PERIOD_END_REASON_ENUM | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
