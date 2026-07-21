import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { EVENT_TYPE_ENUM } from '../enums/event-type.enum';

/**
 * Registro de eventos de dominio para trazabilidad (diagrama ER-V2 más reciente). A propósito
 * sin FK a otras tablas: la nota del diagrama indica que la trazabilidad fina (p. ej. a qué
 * notificación/documento/invitación corresponde un evento) vive dentro de `metadata`, no como
 * relación real — evita acoplar esta tabla a la forma de cada evento distinto y mantiene la
 * cardinalidad simple según el diagrama.
 */
@Entity('events')
export class EventEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'event_type', type: 'enum', enum: EVENT_TYPE_ENUM })
  eventType: EVENT_TYPE_ENUM;

  @Column({ type: 'jsonb', nullable: true })
  metadata: Record<string, unknown> | null;

  /** Origen/actor del evento (string libre, ej. 'system', 'kafka:document.signed', un userId). */
  @Column({ nullable: true })
  from: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
