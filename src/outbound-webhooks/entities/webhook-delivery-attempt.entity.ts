import {
  Check,
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';

import { WEBHOOK_DELIVERY_ATTEMPT_OUTCOME_ENUM } from '../enums/webhook-delivery-attempt-outcome.enum';
import { WebhookDeliveryEntity } from './webhook-delivery.entity';

/**
 * Bitácora de cada POST de una entrega. Se inserta al empezar el intento y se completa al terminar.
 *
 * `finishedAt` y `outcome` quedan en `NULL` si el proceso muere a mitad del intento; la entrega se
 * recupera cuando vence su lease y el siguiente intento lleva el número siguiente
 * (`UQ_webhook_delivery_attempts_delivery_attempt`), sin reescribir el que quedó abierto.
 */
@Entity('webhook_delivery_attempts')
@Index(
  'UQ_webhook_delivery_attempts_delivery_attempt',
  ['deliveryId', 'attemptNumber'],
  { unique: true },
)
@Check(
  'CHK_webhook_delivery_attempts_outcome',
  `"outcome" IS NULL OR "outcome" IN ('SUCCEEDED', 'HTTP_ERROR', 'NETWORK_ERROR', 'TIMEOUT')`,
)
@Check('CHK_webhook_delivery_attempts_attempt_number', `"attempt_number" >= 1`)
@Check(
  'CHK_webhook_delivery_attempts_finished',
  `("finished_at" IS NULL) = ("outcome" IS NULL)`,
)
export class WebhookDeliveryAttemptEntity {
  @PrimaryGeneratedColumn('uuid', {
    primaryKeyConstraintName: 'PK_webhook_delivery_attempts',
  })
  id: string;

  @Column({ name: 'delivery_id', type: 'uuid' })
  deliveryId: string;

  @ManyToOne(() => WebhookDeliveryEntity, (delivery) => delivery.attempts, {
    onDelete: 'RESTRICT',
  })
  @JoinColumn({
    name: 'delivery_id',
    foreignKeyConstraintName: 'FK_webhook_delivery_attempts_delivery_id',
  })
  delivery?: WebhookDeliveryEntity;

  /** Consecutivo por entrega, desde 1. */
  @Column({ name: 'attempt_number', type: 'int' })
  attemptNumber: number;

  /** `null` mientras el intento está en curso o si quedó interrumpido. */
  @Column({ type: 'varchar', length: 20, nullable: true })
  outcome: WEBHOOK_DELIVERY_ATTEMPT_OUTCOME_ENUM | null;

  @Column({ name: 'response_status', type: 'int', nullable: true })
  responseStatus: number | null;

  @Column({ name: 'duration_ms', type: 'int', nullable: true })
  durationMs: number | null;

  @Column({ name: 'error_message', type: 'text', nullable: true })
  errorMessage: string | null;

  @Column({ name: 'started_at', type: 'timestamptz' })
  startedAt: Date;

  @Column({ name: 'finished_at', type: 'timestamptz', nullable: true })
  finishedAt: Date | null;
}
