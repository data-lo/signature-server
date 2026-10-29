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
import { BILLING_INTERVAL_ENUM } from '../enums/billing-interval.enum';
import { CATALOG_PRICE_BILLING_MODE_ENUM } from '../enums/catalog-price-billing-mode.enum';
import { CATALOG_SOURCE_ENUM } from '../enums/catalog-source.enum';
import { CatalogItemEntity } from './catalog-item.entity';
import { PlanEntity } from './plan.entity';

/** Precio versionado de cualquier ítem de catálogo, tanto suscripciones como compras únicas. */
@Entity('catalog_prices')
@Index('IDX_catalog_prices_stripe_price', ['stripePriceId'])
@Index('IDX_catalog_prices_sellable', [
  'catalogItemId',
  'isActive',
  'effectiveFrom',
])
@Check('CHK_catalog_prices_amount', '"amount" >= 0')
@Check(
  'CHK_catalog_prices_recurrence',
  '("billing_mode" = \'ONE_TIME\' AND "interval" IS NULL AND "interval_count" IS NULL) OR ("billing_mode" = \'RECURRING\' AND "interval" IS NOT NULL AND "interval_count" > 0)',
)
export class CatalogPriceEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'catalog_item_id' })
  catalogItemId: string;

  @ManyToOne(() => CatalogItemEntity, (item) => item.prices, {
    onDelete: 'RESTRICT',
  })
  @JoinColumn({ name: 'catalog_item_id' })
  catalogItem: CatalogItemEntity;

  /** Restricción opcional para ofertas de créditos con importe especial por plan. */
  @Column({ name: 'eligible_plan_type', nullable: true, length: 64 })
  eligiblePlanType: string | null;

  @ManyToOne(() => PlanEntity, { nullable: true, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'eligible_plan_type', referencedColumnName: 'planType' })
  eligiblePlan: PlanEntity | null;

  @Column({ type: 'enum', enum: CATALOG_SOURCE_ENUM })
  source: CATALOG_SOURCE_ENUM;

  /** Nullable para importes manuales que aún no se publiquen en Stripe. */
  @Column({ name: 'stripe_price_id', nullable: true })
  stripePriceId: string | null;

  @Column({ type: 'integer' })
  amount: number;

  @Column({ type: 'varchar', length: 3 })
  currency: string;

  @Column({
    name: 'billing_mode',
    type: 'enum',
    enum: CATALOG_PRICE_BILLING_MODE_ENUM,
  })
  billingMode: CATALOG_PRICE_BILLING_MODE_ENUM;

  @Column({ type: 'enum', enum: BILLING_INTERVAL_ENUM, nullable: true })
  interval: BILLING_INTERVAL_ENUM | null;

  @Column({ name: 'interval_count', type: 'integer', nullable: true })
  intervalCount: number | null;

  @Column({ name: 'is_active', default: true })
  isActive: boolean;

  @Column({ name: 'effective_from', type: 'timestamptz', nullable: true })
  effectiveFrom: Date | null;

  @Column({ name: 'effective_to', type: 'timestamptz', nullable: true })
  effectiveTo: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
