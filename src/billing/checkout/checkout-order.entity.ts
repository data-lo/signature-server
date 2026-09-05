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
import { CatalogPriceEntity } from '../catalog/catalog-price.entity';
import { CreditLotEntity } from '../credits/credit-lot.entity';
import { CHECKOUT_KIND_ENUM } from '../enums/checkout-kind.enum';
import { CHECKOUT_ORDER_STATUS_ENUM } from '../enums/checkout-order-status.enum';

@Entity('checkout_orders')
@Index('IDX_checkout_orders_stripe_subscription', ['stripeSubscriptionId'])
@Check('CHK_checkout_orders_amount', '"amount" >= 0')
export class CheckoutOrderEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'billing_profile_id' })
  billingProfileId: string;

  @ManyToOne(() => BillingProfileEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'billing_profile_id' })
  billingProfile: BillingProfileEntity;

  /** La única oferta cobrada; su item determina si es suscripción o créditos. */
  @Column({ name: 'catalog_price_id' })
  catalogPriceId: string;

  @ManyToOne(() => CatalogPriceEntity, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'catalog_price_id' })
  catalogPrice: CatalogPriceEntity;

  /** El slot acreditado por esta orden. Varias órdenes pueden contribuir al mismo periodo. */
  @Column({ name: 'credit_slot_id', nullable: true })
  creditSlotId: string | null;

  @ManyToOne(() => CreditLotEntity, (slot) => slot.checkoutOrders, {
    nullable: true,
    onDelete: 'SET NULL',
  })
  @JoinColumn({ name: 'credit_slot_id' })
  creditSlot: CreditLotEntity | null;

  @Column({ type: 'enum', enum: CHECKOUT_KIND_ENUM })
  kind: CHECKOUT_KIND_ENUM;

  @Column({ name: 'stripe_checkout_session_id', unique: true })
  stripeCheckoutSessionId: string;

  @Column({ name: 'stripe_payment_intent_id', nullable: true, unique: true })
  stripePaymentIntentId: string | null;

  /**
   * Se llena cuando Stripe termina un Checkout de suscripción. No es único: una misma
   * suscripción puede tener varias órdenes históricas vinculadas a ella.
   */
  @Column({ name: 'stripe_subscription_id', nullable: true })
  stripeSubscriptionId: string | null;

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
