import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  OneToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { UserEntity } from 'src/user/entities/user.entity';
import { BillingProfileEntity } from '../profiles/billing-profile.entity';
import { PlanEntity } from '../catalog/plan.entity';
import { CheckoutOrderEntity } from '../checkout/checkout-order.entity';
import { CreditLotEntity } from '../credits/credit-lot.entity';
import { BILLING_SOURCE_ENUM } from '../enums/billing-source.enum';

/**
 * Un renglón por PERIODO FACTURADO: qué plan cubría, entre qué fechas, cuánto se cobró, quién lo
 * cobró y con qué se le sigue el rastro.
 *
 * **Por qué no basta con `billing_profiles`.** El perfil representa únicamente el ESTADO VIGENTE:
 * guarda un solo periodo y cada cobro lo pisa. Eso responde "¿qué tiene hoy este cliente?" pero
 * no "¿desde cuándo?", "¿qué pasó en marzo?", "¿cuánto se le cobró?" ni "¿esto se lo cobró Stripe
 * o se lo facturamos a mano?". Esta tabla es el registro que sobrevive a cada renovación, y
 * separarla del perfil es lo que permite que aquél siga siendo una sola fila trivial de leer.
 *
 * **Sirve igual a los dos orígenes, y ésa es la razón de su forma.** Las columnas de Stripe
 * (`stripe_*`) y las manuales (`external_reference`, `created_by_user_id`, `notes`) son todas
 * nullables porque ningún periodo llena las dos familias: un cobro de Stripe no tiene folio
 * interno y una transferencia no tiene `in_...`. Lo que impide que eso degenere en filas a
 * medias es `CHK_subscription_billing_history_origin_evidence`, que le exige a cada origen
 * exactamente aquello con lo que sí se le puede rastrear.
 */
@Entity('subscription_billing_history')
@Index('IDX_subscription_billing_history_profile', [
  'billingProfileId',
  'periodStart',
])
/**
 * La clave natural de un cobro manual: **una referencia no se puede registrar dos veces para el
 * mismo perfil**.
 *
 * Es lo que convierte "no dupliques el folio 4471" en una garantía del motor y no en una
 * intención del código. Un administrador que reenvía el formulario, o dos que capturan la misma
 * transferencia, chocan contra este índice y la transacción entera se deshace — créditos
 * incluidos. Parcial y sólo sobre `MANUAL` porque los periodos de Stripe se desduplican por
 * `stripe_invoice_id`, y porque un folio nulo no debe competir por la unicidad.
 */
@Index(
  'UQ_subscription_billing_history_manual_reference',
  ['billingProfileId', 'externalReference'],
  {
    unique: true,
    where: `"source" = 'MANUAL' AND "external_reference" IS NOT NULL`,
  },
)
/**
 * Cada origen tiene que aportar aquello con lo que se le puede rastrear, y sin eso la fila no
 * entra:
 *
 * - **`STRIPE` exige `stripe_invoice_id`.** Es el identificador del cobro en el proveedor y, de
 *   paso, la clave de idempotencia de todo el flujo: sin él una re-entrega del webhook no se
 *   podría reconocer como repetida y acreditaría documentos por segunda vez.
 * - **`MANUAL` exige folio o autor.** Un cobro fuera de la plataforma no deja rastro en ningún
 *   sistema externo, así que el rastro tiene que ser interno: la referencia del movimiento
 *   (`external_reference`) o, como mínimo, quién lo registró (`created_by_user_id`). Una fila
 *   manual sin ninguno de los dos sería un plan regalado del que nadie responde.
 *
 * Vive en la base y no sólo en el código porque un `INSERT` de corrección hecho a mano —una
 * migración de datos, un arreglo en caliente— no pasa por el caso de uso que la respeta.
 */
@Check(
  'CHK_subscription_billing_history_origin_evidence',
  `("source" = 'STRIPE' AND "stripe_invoice_id" IS NOT NULL)
   OR ("source" = 'MANUAL' AND ("external_reference" IS NOT NULL OR "created_by_user_id" IS NOT NULL))`,
)
@Check('CHK_subscription_billing_history_amount', '"amount" >= 0')
@Check(
  'CHK_subscription_billing_history_period',
  '"period_start" < "period_end"',
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
   * La orden de compra que originó este periodo, cuando la hubo.
   *
   * Nula en dos casos legítimos y muy distintos: una RENOVACIÓN de Stripe (el cliente no vuelve
   * a pasar por Checkout, así que no hay orden nueva que apuntar) y un cobro MANUAL (nunca hubo
   * Checkout). Sólo el alta inicial contratada por el usuario la tiene.
   */
  @Column({ name: 'checkout_order_id', nullable: true })
  checkoutOrderId: string | null;

  @ManyToOne(() => CheckoutOrderEntity, {
    nullable: true,
    onDelete: 'SET NULL',
  })
  @JoinColumn({ name: 'checkout_order_id' })
  checkoutOrder: CheckoutOrderEntity | null;

  /**
   * El lote de documentos que este periodo emitió, uno a uno.
   *
   * `OneToOne` y con la columna única a propósito: un periodo concede su saldo UNA vez, y que dos
   * renglones del historial pudieran señalar el mismo lote significaría que un cobro se registró
   * dos veces repartiéndose unos créditos emitidos una sola. El índice único es lo que convierte
   * "cada historial se vincula a un único credit_lot" en algo que impone el motor.
   */
  @Column({ name: 'credit_slot_id', nullable: true, unique: true })
  creditSlotId: string | null;

  @OneToOne(() => CreditLotEntity, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'credit_slot_id' })
  creditSlot: CreditLotEntity | null;

  @Column({
    type: 'enum',
    enum: BILLING_SOURCE_ENUM,
    enumName: 'billing_source_enum',
  })
  source: BILLING_SOURCE_ENUM;

  /**
   * El plan que cubría ESTE periodo, no el que el perfil tenga hoy. Se guarda aparte justamente
   * porque el del perfil cambia: un cliente que subió de `basic` a `plus` tiene que seguir
   * viendo `basic` en los meses que pagó como `basic`.
   *
   * `ON DELETE RESTRICT` y no `SET NULL` como en el perfil: la columna es obligatoria, así que el
   * motor no podría "olvidarla" sin dejar la fila inválida. Borrar un plan con periodos
   * facturados a su nombre queda bloqueado, que es lo correcto — el catálogo se retira con
   * `is_active`, no borrando filas de las que cuelga la facturación.
   */
  @Column({ name: 'plan_type', type: 'varchar', length: 64 })
  planType: string;

  @ManyToOne(() => PlanEntity, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'plan_type', referencedColumnName: 'planType' })
  plan: PlanEntity;

  /**
   * Importe cobrado por el periodo, en la unidad mínima de la moneda (centavos), igual que en
   * `checkout_orders` y que en la propia API de Stripe. Entero y nunca decimal: los flotantes no
   * representan exactamente los importes y sumarlos acumula error justo donde no se puede.
   *
   * Se permite `0` —una cortesía, una migración, un periodo de gracia registrado a mano— pero no
   * negativo: una devolución no es un periodo facturado y no se representa como uno.
   */
  @Column({ type: 'integer' })
  amount: number;

  @Column({ type: 'varchar', length: 3 })
  currency: string;

  @Column({ name: 'period_start', type: 'timestamptz' })
  periodStart: Date;

  @Column({ name: 'period_end', type: 'timestamptz' })
  periodEnd: Date;

  /**
   * Cuándo se cobró de verdad, que no es cuándo lo registramos.
   *
   * Se separa de `created_at` porque pueden distar mucho: una transferencia recibida el día 2 y
   * capturada por administración el día 9 tiene `paid_at` el 2 y `created_at` el 9. Confundirlos
   * falsearía cualquier corte de caja.
   */
  @Column({ name: 'paid_at', type: 'timestamptz' })
  paidAt: Date;

  @Column({ name: 'stripe_customer_id', nullable: true })
  stripeCustomerId: string | null;

  @Column({ name: 'stripe_subscription_id', nullable: true })
  stripeSubscriptionId: string | null;

  /**
   * Único: la misma factura de Stripe no puede abrir dos periodos. Es la clave de idempotencia
   * del webhook —Stripe reintenta las entregas durante días— y la última red por debajo de la
   * comprobación que hace `RegisterSubscriptionBillingUseCase`.
   *
   * En Postgres un `UNIQUE` admite tantos `NULL` como haga falta, que es justo lo que necesitan
   * los cobros manuales: son todos "sin factura" sin estorbarse entre sí.
   */
  @Column({ name: 'stripe_invoice_id', nullable: true, unique: true })
  stripeInvoiceId: string | null;

  @Column({ name: 'stripe_payment_intent_id', nullable: true })
  stripePaymentIntentId: string | null;

  /**
   * El rastro del cobro fuera de la plataforma: folio interno, referencia de la transferencia,
   * número de la factura emitida por administración. Es además la clave de idempotencia del
   * origen manual (ver `UQ_subscription_billing_history_manual_reference`), así que conviene que
   * sea el identificador real del movimiento y no una nota libre — para eso está `notes`.
   */
  @Column({ name: 'external_reference', type: 'varchar', nullable: true })
  externalReference: string | null;

  /**
   * Quién registró el cobro manual. `ON DELETE SET NULL` y no `RESTRICT`: dar de baja a un
   * empleado no puede quedar bloqueado por las facturas que capturó, y perder el autor es menos
   * grave que perder el periodo — el folio de `external_reference` sigue siendo el rastro
   * principal.
   */
  @Column({ name: 'created_by_user_id', nullable: true })
  createdByUserId: string | null;

  @ManyToOne(() => UserEntity, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'created_by_user_id' })
  createdByUser: UserEntity | null;

  @Column({ type: 'text', nullable: true })
  notes: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
