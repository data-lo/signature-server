import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { EVENT_TYPE_ENUM } from '../enums/event-type.enum';

/**
 * Registro de eventos de dominio para trazabilidad (diagrama ER-V2 más reciente). A propósito
 * sin FK a otras tablas: la nota del diagrama indica que la trazabilidad fina (p. ej. a qué
 * notificación/documento/invitación corresponde un evento) vive dentro de `metadata`, no como
 * relación real — evita acoplar esta tabla a la forma de cada evento distinto y mantiene la
 * cardinalidad simple según el diagrama.
 *
 * Desde la historia del flujo de aprobación esta tabla **es además la outbox transaccional**: la
 * fila se escribe dentro de la misma transacción que cambia el estado del documento y se publica
 * en Kafka después de confirmarla (ver `OutboxService`). `metadata` guarda el sobre completo del
 * evento, que es lo que se publica —antes guardaba un resumen—, para que republicar no dependa de
 * poder reconstruirlo.
 */
/**
 * Índice PARCIAL sobre lo que queda por publicar. Se declara aquí y no sólo en la migración para
 * que la entidad y la tabla no discrepen (`schema:log` lo propondría borrar). Parcial y no
 * completo porque las filas pendientes son siempre unas pocas mientras las publicadas crecen sin
 * límite: buscar lo que falta no debe degradarse con el histórico.
 */
@Index('IDX_events_pending_publication', ['createdAt'], {
  where: '"published_at" IS NULL',
})
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

  /**
   * Cuándo se publicó en Kafka, o `NULL` si todavía no (ver migración
   * `IntroduceTransactionalOutbox`). Es el estado de la outbox: la fila se escribe dentro de la
   * transacción que cambia el estado del documento, y la publicación es un paso posterior y
   * reintentable que marca esta columna al confirmarse.
   */
  @Column({ name: 'published_at', nullable: true })
  publishedAt: Date | null;

  /**
   * Versión del CONTRATO del evento, que viaja en el sobre hacia los consumidores. Sirve para que
   * un consumidor pueda distinguir una carga vieja de una nueva el día que el formato cambie;
   * hoy todos los eventos son la versión 1.
   */
  @Column({ type: 'int', default: 1 })
  version: number;

  /** Momento en que ocurrió el hecho: es el `occurredAt` del sobre, no el de su publicación. */
  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
