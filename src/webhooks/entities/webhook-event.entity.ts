import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';
import { WEBHOOK_PROVIDER_ENUM } from '../enums/webhook-provider.enum';
import { WEBHOOK_PROCESSING_STATUS_ENUM } from '../enums/webhook-processing-status.enum';

/**
 * Bitácora de entregas de webhook de proveedores externos (Didit, Stripe).
 *
 * Es el registro de idempotencia del módulo: antes de delegar al dominio se inserta la fila,
 * y `UNIQUE(provider, provider_event_id)` garantiza que una re-entrega del mismo evento no
 * pueda ejecutar las reglas de negocio dos veces. A propósito sin FKs a documentos, cuentas
 * ni verificaciones: esta tabla describe *la entrega HTTP*, no el objeto de dominio que el
 * evento termine tocando.
 */
@Entity('webhook_events')
@Unique('UQ_webhook_events_provider_event', ['provider', 'providerEventId'])
@Index('IDX_webhook_events_provider_status', ['provider', 'processingStatus'])
@Index('IDX_webhook_events_received_at', ['receivedAt'])
export class WebhookEventEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'enum', enum: WEBHOOK_PROVIDER_ENUM })
  provider: WEBHOOK_PROVIDER_ENUM;

  /**
   * Identificador del evento tal como lo asigna el proveedor (`evt_...` en Stripe).
   *
   * Nullable porque una entrega rechazada por firma inválida se audita sin leer el cuerpo:
   * ahí no hay identificador confiable. Postgres no considera iguales dos NULL en un índice
   * único, así que esas filas de auditoría conviven sin chocar entre sí.
   */
  @Column({ name: 'provider_event_id', type: 'varchar', nullable: true })
  providerEventId: string | null;

  @Column({ name: 'event_type', type: 'varchar' })
  eventType: string;

  /**
   * `true` sólo si el proveedor firmó el evento y la firma verificó contra nuestro secreto.
   * Una fila con `false` es evidencia de un intento no confiable: nunca ejecutó dominio.
   */
  @Column({ name: 'signature_valid', type: 'boolean' })
  signatureValid: boolean;

  @Column({
    name: 'processing_status',
    type: 'enum',
    enum: WEBHOOK_PROCESSING_STATUS_ENUM,
    default: WEBHOOK_PROCESSING_STATUS_ENUM.RECEIVED,
  })
  processingStatus: WEBHOOK_PROCESSING_STATUS_ENUM;

  /** Cuerpo del evento ya verificado. Queda NULL en las filas de firma inválida. */
  @Column({ type: 'jsonb', nullable: true })
  payload: Record<string, unknown> | null;

  @Column({
    name: 'received_at',
    type: 'timestamptz',
    default: () => 'now()',
  })
  receivedAt: Date;

  @Column({ name: 'processed_at', type: 'timestamptz', nullable: true })
  processedAt: Date | null;

  /** Detalle del fallo cuando `processing_status = FAILED`. */
  @Column({ type: 'text', nullable: true })
  error: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
