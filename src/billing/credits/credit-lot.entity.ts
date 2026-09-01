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
import { CheckoutOrderEntity } from '../checkout/checkout-order.entity';
import { CREDIT_LOT_ORIGIN_ENUM } from '../enums/credit-lot-origin.enum';

@Entity('credit_lots')
@Index('IDX_credit_lots_consumption', [
  'billingProfileId',
  'origin',
  'remaining',
  'periodEnd',
])
@Check('CHK_credit_lots_issued', '"issued" > 0')
@Check(
  'CHK_credit_lots_remaining',
  '"remaining" >= 0 AND "remaining" <= "issued"',
)
export class CreditLotEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'billing_profile_id' })
  billingProfileId: string;

  @ManyToOne(() => BillingProfileEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'billing_profile_id' })
  billingProfile: BillingProfileEntity;

  @Column({ name: 'checkout_order_id', nullable: true, unique: true })
  checkoutOrderId: string | null;

  @ManyToOne(() => CheckoutOrderEntity, {
    nullable: true,
    onDelete: 'SET NULL',
  })
  @JoinColumn({ name: 'checkout_order_id' })
  checkoutOrder: CheckoutOrderEntity | null;

  @Column({ type: 'enum', enum: CREDIT_LOT_ORIGIN_ENUM })
  origin: CREDIT_LOT_ORIGIN_ENUM;

  @Column({ type: 'integer' })
  issued: number;

  @Column({ type: 'integer' })
  remaining: number;

  @Column({ type: 'integer', default: 0 })
  priority: number;

  @Column({ name: 'stripe_invoice_id', nullable: true, unique: true })
  stripeInvoiceId: string | null;

  @Column({ name: 'stripe_payment_intent_id', nullable: true, unique: true })
  stripePaymentIntentId: string | null;

  @Column({ name: 'period_start', type: 'timestamptz', nullable: true })
  periodStart: Date | null;

  @Column({ name: 'period_end', type: 'timestamptz', nullable: true })
  periodEnd: Date | null;

  @Column({ name: 'expires_at', type: 'timestamptz', nullable: true })
  expiresAt: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
