import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

import { CREDIT_LEDGER_MOVEMENT_TYPE_ENUM } from '../enums/credit-ledger-movement-type.enum';
import { CREDIT_TYPE_ENUM } from '../enums/credit-type.enum';

/**
 * Un movimiento de créditos: compra, concesión, reserva, consumo o liberación.
 *
 * **Es inmutable.** Un trigger de la base (`TRG_credit_ledger_entries_immutable`) rechaza todo
 * `UPDATE` y `DELETE`, y las referencias a perfil y lote son `RESTRICT`: lo que se registró aquí
 * no se corrige ni desaparece; un error se compensa con otro movimiento.
 *
 * **Cada cambio de `credit_lots.remaining` o `credit_lots.reserved` escribe una fila**, en la
 * misma transacción que el cambio. Por eso el saldo de cualquier lote puede reconstruirse
 * sumando sus movimientos (ver la tabla de `CREDIT_LEDGER_MOVEMENT_TYPE_ENUM`).
 *
 * **`idempotency_key` es único**, y es la defensa contra reintentos: el segundo intento de
 * registrar el mismo hecho (otra entrega del webhook, otro clic) choca contra el índice. Cada
 * escritor arma la clave a partir del hecho que registra, p. ej. `reserve:BIOMETRIC_SIGNATURE:<intento>`.
 *
 * `document_id`, `biometric_signature_attempt_id` y `stripe_payment_intent_id` son referencias
 * históricas sin FK: el ledger tiene que poder contar qué pasó aunque el objeto cambie después.
 */
@Entity('credit_ledger_entries')
@Index('UQ_credit_ledger_entries_idempotency_key', ['idempotencyKey'], {
  unique: true,
})
@Index('IDX_credit_ledger_entries_profile_created', [
  'billingProfileId',
  'createdAt',
])
@Index('IDX_credit_ledger_entries_lot', ['creditLotId'])
@Check('CHK_credit_ledger_entries_quantity', '"quantity" > 0')
export class CreditLedgerEntryEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'billing_profile_id', type: 'uuid' })
  billingProfileId: string;

  /** Lote afectado. Siempre presente en los movimientos que escribe el sistema hoy. */
  @Column({ name: 'credit_lot_id', type: 'uuid', nullable: true })
  creditLotId: string | null;

  @Column({
    name: 'credit_type',
    type: 'enum',
    enum: CREDIT_TYPE_ENUM,
    enumName: 'credit_type_enum',
  })
  creditType: CREDIT_TYPE_ENUM;

  @Column({
    name: 'movement_type',
    type: 'enum',
    enum: CREDIT_LEDGER_MOVEMENT_TYPE_ENUM,
    enumName: 'credit_ledger_movement_type_enum',
  })
  movementType: CREDIT_LEDGER_MOVEMENT_TYPE_ENUM;

  /** Siempre positiva: el sentido lo da `movementType`. */
  @Column({ type: 'integer' })
  quantity: number;

  /**
   * Reserva a la que pertenece el movimiento (`RESERVE`, y `CONSUME`/`RELEASE` de una reserva).
   * Es lo que distingue un consumo que libera `reserved` de un consumo inmediato.
   */
  @Column({ name: 'credit_reservation_id', type: 'uuid', nullable: true })
  creditReservationId: string | null;

  @Column({ name: 'document_id', type: 'uuid', nullable: true })
  documentId: string | null;

  @Column({
    name: 'biometric_signature_attempt_id',
    type: 'uuid',
    nullable: true,
  })
  biometricSignatureAttemptId: string | null;

  @Column({ name: 'stripe_payment_intent_id', type: 'varchar', nullable: true })
  stripePaymentIntentId: string | null;

  @Column({ name: 'idempotency_key', type: 'varchar', length: 255 })
  idempotencyKey: string;

  /** Contexto libre (motivo de una liberación, origen del lote…). Nunca datos personales. */
  @Column({ type: 'jsonb', nullable: true })
  metadata: Record<string, unknown> | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
