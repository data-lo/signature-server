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
} from 'typeorm';

import { EventEntity } from 'src/event/entities/event.entity';

import { OUTBOUND_WEBHOOK_EVENT_TYPE_ENUM } from '../enums/outbound-webhook-event-type.enum';
import { WEBHOOK_DELIVERY_STATUS_ENUM } from '../enums/webhook-delivery-status.enum';
import { WebhookPayloadV1 } from '../interfaces/webhook-payload-v1.interface';
import { WebhookDeliveryAttemptEntity } from './webhook-delivery-attempt.entity';
import { WebhookEndpointEntity } from './webhook-endpoint.entity';
import { WebhookSecretVersionEntity } from './webhook-secret-version.entity';

/**
 * Entrega lógica de un evento de `events` hacia un endpoint. Su `id` viaja en
 * `X-Signature-Webhook-Id` y no cambia entre reintentos.
 *
 * - `UQ_webhook_deliveries_endpoint_event` hace idempotente el registro: reprocesar el mismo evento
 *   no crea una segunda entrega para el mismo endpoint.
 * - `destinationUrl`, `payload` y `secretVersionId` son snapshots del momento del registro. Cambiar
 *   la URL, desactivar el endpoint o rotar el secreto no altera las entregas ya creadas.
 * - `FK_webhook_deliveries_secret_version_endpoint` es compuesta: el secreto tiene que pertenecer
 *   al mismo endpoint de la entrega.
 * - No hay FK a `documents`: el documento va en el payload, y así la tabla sirve para eventos
 *   futuros que no sean de documentos.
 * - `IDX_webhook_deliveries_status_next_attempt` sirve al worker para reclamar lo vencido y
 *   `IDX_webhook_deliveries_endpoint_created_at` al historial paginado del endpoint.
 */
@Entity('webhook_deliveries')
@Index(
  'UQ_webhook_deliveries_endpoint_event',
  ['endpointId', 'sourceEventId'],
  {
    unique: true,
  },
)
@Index('IDX_webhook_deliveries_status_next_attempt', [
  'status',
  'nextAttemptAt',
])
@Index('IDX_webhook_deliveries_endpoint_created_at', [
  'endpointId',
  'createdAt',
])
@Check(
  'CHK_webhook_deliveries_status',
  `"status" IN ('PENDING', 'DELIVERING', 'RETRY_SCHEDULED', 'DELIVERED', 'FAILED', 'CANCELLED')`,
)
@Check(
  'CHK_webhook_deliveries_event_type',
  `"event_type" IN ('document.collaborator_signed', 'document.signed', 'document.rejected', 'document.cancelled')`,
)
@Check('CHK_webhook_deliveries_attempt_count', `"attempt_count" >= 0`)
@Check(
  'CHK_webhook_deliveries_delivered_at',
  `("status" = 'DELIVERED') = ("delivered_at" IS NOT NULL)`,
)
@Check(
  'CHK_webhook_deliveries_lease',
  `"status" <> 'DELIVERING' OR "lease_expires_at" IS NOT NULL`,
)
export class WebhookDeliveryEntity {
  @PrimaryGeneratedColumn('uuid', {
    primaryKeyConstraintName: 'PK_webhook_deliveries',
  })
  id: string;

  @Column({ name: 'endpoint_id', type: 'uuid' })
  endpointId: string;

  @ManyToOne(() => WebhookEndpointEntity, { onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'endpoint_id',
    foreignKeyConstraintName: 'FK_webhook_deliveries_endpoint_id',
  })
  endpoint?: WebhookEndpointEntity;

  /** Versión del secreto con la que se firman todos los intentos de esta entrega. */
  @Column({ name: 'secret_version_id', type: 'uuid' })
  secretVersionId: string;

  @ManyToOne(() => WebhookSecretVersionEntity, { onDelete: 'RESTRICT' })
  @JoinColumn([
    {
      name: 'secret_version_id',
      referencedColumnName: 'id',
      foreignKeyConstraintName: 'FK_webhook_deliveries_secret_version_endpoint',
    },
    { name: 'endpoint_id', referencedColumnName: 'endpointId' },
  ])
  secretVersion?: WebhookSecretVersionEntity;

  /** Evento durable de origen; su `id` es el `id` del payload. */
  @Column({ name: 'source_event_id', type: 'uuid' })
  sourceEventId: string;

  @ManyToOne(() => EventEntity, { onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'source_event_id',
    foreignKeyConstraintName: 'FK_webhook_deliveries_source_event_id',
  })
  sourceEvent?: EventEntity;

  @Column({ name: 'event_type', type: 'varchar', length: 100 })
  eventType: OUTBOUND_WEBHOOK_EVENT_TYPE_ENUM;

  /**
   * Cuerpo público tal como se armó al registrar la entrega. `jsonb` no conserva el orden de las
   * claves: cada intento serializa de nuevo y firma exactamente los bytes que envía.
   */
  @Column({ type: 'jsonb' })
  payload: WebhookPayloadV1;

  /** URL del endpoint al registrar la entrega. */
  @Column({ name: 'destination_url', type: 'text' })
  destinationUrl: string;

  @Column({
    type: 'varchar',
    length: 20,
    default: WEBHOOK_DELIVERY_STATUS_ENUM.PENDING,
  })
  status: WEBHOOK_DELIVERY_STATUS_ENUM;

  /** Intentos realizados, automáticos y manuales; es el `attempt_number` del último. */
  @Column({ name: 'attempt_count', type: 'int', default: 0 })
  attemptCount: number;

  /** Cuándo toca el siguiente intento; `null` en estados finales y en `FAILED`. */
  @Column({ name: 'next_attempt_at', type: 'timestamptz', nullable: true })
  nextAttemptAt: Date | null;

  @Column({ name: 'last_attempt_at', type: 'timestamptz', nullable: true })
  lastAttemptAt: Date | null;

  /** Hasta cuándo el worker que la reclamó la tiene en `DELIVERING`. */
  @Column({ name: 'lease_expires_at', type: 'timestamptz', nullable: true })
  leaseExpiresAt: Date | null;

  @Column({ name: 'delivered_at', type: 'timestamptz', nullable: true })
  deliveredAt: Date | null;

  @Column({ name: 'last_response_status', type: 'int', nullable: true })
  lastResponseStatus: number | null;

  /** Causa del último fallo, sin el cuerpo de la respuesta del destino. */
  @Column({ name: 'last_error', type: 'text', nullable: true })
  lastError: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @OneToMany(() => WebhookDeliveryAttemptEntity, (attempt) => attempt.delivery)
  attempts?: WebhookDeliveryAttemptEntity[];
}
