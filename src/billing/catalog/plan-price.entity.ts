import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { BILLING_INTERVAL_ENUM } from '../enums/billing-interval.enum';
import { PlanEntity } from './plan.entity';

@Entity('plan_prices')
@Check('CHK_plan_prices_amount', '"amount" >= 0')
@Check('CHK_plan_prices_interval_count', '"interval_count" > 0')
export class PlanPriceEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'plan_code', length: 64 })
  planCode: string;

  @ManyToOne(() => PlanEntity, (plan) => plan.prices, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'plan_code', referencedColumnName: 'code' })
  plan: PlanEntity;

  @Column({ name: 'stripe_price_id', unique: true })
  stripePriceId: string;

  @Column({ type: 'integer' })
  amount: number;

  @Column({ type: 'varchar', length: 3 })
  currency: string;

  @Column({ type: 'enum', enum: BILLING_INTERVAL_ENUM })
  interval: BILLING_INTERVAL_ENUM;

  @Column({ name: 'interval_count', type: 'integer', default: 1 })
  intervalCount: number;

  @Column({ default: true })
  active: boolean;

  @Column({ name: 'effective_from', type: 'timestamptz', nullable: true })
  effectiveFrom: Date | null;

  @Column({ name: 'effective_to', type: 'timestamptz', nullable: true })
  effectiveTo: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
