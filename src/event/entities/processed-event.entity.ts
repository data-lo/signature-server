import { CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';

/**
 * Marca de que un consumidor ya procesó un evento concreto (ver migración
 * `IntroduceTransactionalOutbox`).
 *
 * Es lo que hace idempotente el consumo: Kafka garantiza *al menos una* entrega, así que un
 * reintento —por un rebalanceo del grupo, un fallo antes de confirmar el offset, o la reentrega de
 * un evento que la outbox republicó— vuelve a traer el mismo `eventId`. Insertar esta fila ANTES
 * de hacer el trabajo, y abandonar si ya existía, convierte "procesar dos veces" en "procesar una
 * y descartar la segunda".
 *
 * La llave primaria es compuesta y no sólo `event_id` porque cada consumidor procesa el mismo
 * evento por su cuenta: que la auditoría ya lo haya encadenado no debe impedir que el envío de
 * correos lo trate.
 */
@Entity('processed_events')
export class ProcessedEventEntity {
  /** `events.id` del evento consumido; viaja en el sobre como `eventId`. */
  @PrimaryColumn({ name: 'event_id', type: 'uuid' })
  eventId: string;

  /** Nombre estable del consumidor, no su clase: renombrar la clase no debe reprocesar el pasado. */
  @PrimaryColumn({ type: 'varchar' })
  consumer: string;

  @CreateDateColumn({ name: 'processed_at' })
  processedAt: Date;
}
