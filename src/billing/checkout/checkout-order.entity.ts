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
import { BillingProfileEntity } from '../profiles/billing-profile.entity';
import { PlanPriceEntity } from '../catalog/plan-price.entity';
import { DocumentPackOfferEntity } from '../catalog/document-pack-offer.entity';
import { CHECKOUT_KIND_ENUM } from '../enums/checkout-kind.enum';
import { CHECKOUT_ORDER_STATUS_ENUM } from '../enums/checkout-order-status.enum';

@Entity('checkout_orders')
@Check('CHK_checkout_orders_amount', '"amount" >= 0')
@Check(
  'CHK_checkout_orders_item_matches_kind',
  '("kind" = \'SUBSCRIPTION\' AND "plan_price_id" IS NOT NULL AND "document_pack_offer_id" IS NULL) OR ("kind" = \'ADD_ON\' AND "plan_price_id" IS NULL AND "document_pack_offer_id" IS NOT NULL)',
)
export class CheckoutOrderEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'billing_profile_id' })
  billingProfileId: string;

  @ManyToOne(() => BillingProfileEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'billing_profile_id' })
  billingProfile: BillingProfileEntity;

  @Column({ name: 'plan_price_id', nullable: true })
  planPriceId: string | null;

  @ManyToOne(() => PlanPriceEntity, { nullable: true, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'plan_price_id' })
  planPrice: PlanPriceEntity | null;

  @Column({ name: 'document_pack_offer_id', nullable: true })
  documentPackOfferId: string | null;

  @ManyToOne(() => DocumentPackOfferEntity, {
    nullable: true,
    onDelete: 'RESTRICT',
  })
  @JoinColumn({ name: 'document_pack_offer_id' })
  documentPackOffer: DocumentPackOfferEntity | null;

  @Column({ type: 'enum', enum: CHECKOUT_KIND_ENUM })
  kind: CHECKOUT_KIND_ENUM;

  @Column({ name: 'stripe_checkout_session_id', unique: true })
  stripeCheckoutSessionId: string;

  @Column({ name: 'stripe_payment_intent_id', nullable: true, unique: true })
  stripePaymentIntentId: string | null;

  @Column({
    type: 'enum',
    enum: CHECKOUT_ORDER_STATUS_ENUM,
    default: CHECKOUT_ORDER_STATUS_ENUM.PENDING,
  })
  status: CHECKOUT_ORDER_STATUS_ENUM;

  @Column({ type: 'integer' })
  amount: number;

  @Column({ type: 'varchar', length: 3 })
  currency: string;

  @Column({ name: 'completed_at', type: 'timestamptz', nullable: true })
  completedAt: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
