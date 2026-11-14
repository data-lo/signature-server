import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';
import { BillingProfileEntity } from '../profiles/billing-profile.entity';
import { CheckoutOrderEntity } from '../checkout/checkout-order.entity';
import { CREDIT_LOT_ORIGIN_ENUM } from '../enums/credit-lot-origin.enum';
import { CREDIT_TYPE_ENUM } from '../enums/credit-type.enum';

/**
 * Un lote de créditos de un perfil de facturación, y la fuente de su saldo.
 *
 * - `remaining`: créditos que todavía no se consumen.
 * - `reserved`: de ésos, los bloqueados por una reserva activa (`credit_reservations`).
 * - Disponible = `remaining - reserved`.
 *
 * Reservar sube `reserved`; consumir una reserva baja `remaining` y `reserved`; liberarla baja sólo
 * `reserved`. Los `CHECK` impiden que un descuento deje cualquiera de los dos en negativo o que se
 * reserve más de lo que queda. Cada cambio deja su movimiento en `credit_ledger_entries`.
 */
@Entity('credit_lots')
@Index('IDX_credit_lots_consumption', [
  'billingProfileId',
  'creditType',
  'origin',
  'remaining',
  'periodEnd',
])
@Index('IDX_credit_lots_stripe_subscription', ['stripeSubscriptionId'])
/** Destino de la FK compuesta de reservas y ledger: lote, perfil y tipo tienen que coincidir. */
@Unique('UQ_credit_lots_id_profile_type', [
  'id',
  'billingProfileId',
  'creditType',
])
@Check('CHK_credit_lots_issued', '"issued" > 0')
@Check(
  'CHK_credit_lots_remaining',
  '"remaining" >= 0 AND "remaining" <= "issued"',
)
@Check(
  'CHK_credit_lots_reserved',
  '"reserved" >= 0 AND "reserved" <= "remaining"',
)
export class CreditLotEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'billing_profile_id' })
  billingProfileId: string;

  @ManyToOne(() => BillingProfileEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'billing_profile_id' })
  billingProfile: BillingProfileEntity;

  /** Las órdenes señalan el slot que acreditan; un periodo puede recibir varias compras. */
  @OneToMany(() => CheckoutOrderEntity, (order) => order.creditSlot)
  checkoutOrders: CheckoutOrderEntity[];

  @Column({ type: 'enum', enum: CREDIT_LOT_ORIGIN_ENUM })
  origin: CREDIT_LOT_ORIGIN_ENUM;

  @Column({ type: 'integer' })
  issued: number;

  /** Para qué sirven sus créditos. Los lotes anteriores a los créditos biométricos son documentales. */
  @Column({
    name: 'credit_type',
    type: 'enum',
    enum: CREDIT_TYPE_ENUM,
    enumName: 'credit_type_enum',
    default: CREDIT_TYPE_ENUM.DOCUMENT_SIGNATURE,
  })
  creditType: CREDIT_TYPE_ENUM;

  @Column({ type: 'integer' })
  remaining: number;

  /** Créditos de `remaining` bloqueados por reservas activas; nunca más que `remaining`. */
  @Column({ type: 'integer', default: 0 })
  reserved: number;

  @Column({ type: 'integer', default: 0 })
  priority: number;

  @Column({ name: 'stripe_invoice_id', nullable: true, unique: true })
  stripeInvoiceId: string | null;

  @Column({ name: 'stripe_payment_intent_id', nullable: true, unique: true })
  stripePaymentIntentId: string | null;

  /** La suscripción cuyo periodo emitió este slot; permite enlazar la orden aunque los webhooks lleguen fuera de orden. */
  @Column({ name: 'stripe_subscription_id', nullable: true })
  stripeSubscriptionId: string | null;

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
