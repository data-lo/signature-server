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
import { PlanEntity } from './plan.entity';

@Entity('plan_prices')
@Index('IDX_plan_prices_stripe_price_id', ['stripePriceId'])
@Check('CHK_plan_prices_amount', '"amount" >= 0')
@Check('CHK_plan_prices_interval_count', '"interval_count" > 0')
export class PlanPriceEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'plan_type', length: 64 })
  planType: string;

  /** Entidad heredada: checkout nuevo usa catalog_prices. */
  @ManyToOne(() => PlanEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'plan_type', referencedColumnName: 'planType' })
  plan: PlanEntity;

  // No es único: una edición del precio puede conservar el mismo `price_...` y cada versión
  // local debe permanecer disponible para órdenes e facturas históricas.
  @Column({ name: 'stripe_price_id' })
  stripePriceId: string;

  @Column({ type: 'integer' })
  amount: number;

  @Column({ type: 'varchar', length: 3 })
  currency: string;

  @Column({ type: 'enum', enum: BILLING_INTERVAL_ENUM })
  interval: BILLING_INTERVAL_ENUM;

  @Column({ name: 'interval_count', type: 'integer', default: 1 })
  intervalCount: number;

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
