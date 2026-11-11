import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

import { CREDIT_RESERVATION_STATUS_ENUM } from '../enums/credit-reservation-status.enum';
import { CREDIT_TYPE_ENUM } from '../enums/credit-type.enum';

/**
 * Créditos bloqueados de un lote mientras se decide si se cobran.
 *
 * - Documental (`DOCUMENT_SIGNATURE`): un documento biométrico reserva su crédito al crearse y lo
 *   consume cuando se completa; si se rechaza o se cancela antes, lo libera.
 * - Biométrica (`BIOMETRIC_SIGNATURE`): cada intento de Didit reserva un crédito antes de abrir la
 *   sesión y lo consume sólo si la firma queda registrada.
 *
 * Garantías de la base:
 * - Una sola reserva documental ACTIVA por documento y una sola biométrica ACTIVA por intento
 *   (índices únicos parciales).
 * - Lote, perfil y tipo de crédito coinciden con los del lote (FK compuesta a
 *   `credit_lots (id, billing_profile_id, credit_type)`): una reserva no puede bloquear saldo de
 *   otro perfil ni de otro tipo.
 * - `quantity > 0`.
 *
 * El estado sólo se mueve desde `ACTIVE` y con un `UPDATE` condicionado (ver
 * `CreditReservationService`), así que un reintento no consume ni libera dos veces.
 */
@Entity('credit_reservations')
@Index('UQ_credit_reservations_active_document', ['documentId'], {
  unique: true,
  where: `"status" = 'ACTIVE' AND "credit_type" = 'DOCUMENT_SIGNATURE'`,
})
@Index(
  'UQ_credit_reservations_active_biometric_attempt',
  ['biometricSignatureAttemptId'],
  {
    unique: true,
    where: `"status" = 'ACTIVE' AND "credit_type" = 'BIOMETRIC_SIGNATURE'`,
  },
)
@Index('IDX_credit_reservations_active_expiry', ['expiresAt'], {
  where: `"status" = 'ACTIVE'`,
})
@Index('IDX_credit_reservations_document', ['documentId'])
@Check('CHK_credit_reservations_quantity', '"quantity" > 0')
@Check(
  'CHK_credit_reservations_subject',
  `("credit_type" = 'DOCUMENT_SIGNATURE' AND "document_id" IS NOT NULL) OR ("credit_type" = 'BIOMETRIC_SIGNATURE' AND "biometric_signature_attempt_id" IS NOT NULL)`,
)
export class CreditReservationEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'billing_profile_id', type: 'uuid' })
  billingProfileId: string;

  @Column({ name: 'credit_lot_id', type: 'uuid' })
  creditLotId: string;

  @Column({
    name: 'credit_type',
    type: 'enum',
    enum: CREDIT_TYPE_ENUM,
    enumName: 'credit_type_enum',
  })
  creditType: CREDIT_TYPE_ENUM;

  /** Documento que paga (documental) o al que pertenece el intento (biométrica). */
  @Column({ name: 'document_id', type: 'uuid', nullable: true })
  documentId: string | null;

  /** Intento de Didit que paga; sólo en reservas biométricas. */
  @Column({
    name: 'biometric_signature_attempt_id',
    type: 'uuid',
    nullable: true,
  })
  biometricSignatureAttemptId: string | null;

  @Column({ type: 'integer' })
  quantity: number;

  @Column({
    type: 'enum',
    enum: CREDIT_RESERVATION_STATUS_ENUM,
    enumName: 'credit_reservation_status_enum',
    default: CREDIT_RESERVATION_STATUS_ENUM.ACTIVE,
  })
  status: CREDIT_RESERVATION_STATUS_ENUM;

  /** Cuándo puede liberarla el job de expiración; `null` = no vence sola (documental). */
  @Column({ name: 'expires_at', type: 'timestamptz', nullable: true })
  expiresAt: Date | null;

  @Column({ name: 'consumed_at', type: 'timestamptz', nullable: true })
  consumedAt: Date | null;

  @Column({ name: 'released_at', type: 'timestamptz', nullable: true })
  releasedAt: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
