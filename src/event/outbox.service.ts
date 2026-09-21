import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, IsNull, Repository } from 'typeorm';

import { KafkaProducerService } from 'src/kafka/kafka-producer.service';

import { EventEntity } from './entities/event.entity';
import { EVENT_TYPE_ENUM } from './enums/event-type.enum';

/** Versión del contrato de los eventos que se publican hoy. */
export const EVENT_CONTRACT_VERSION = 1;

/** Lo que el llamador aporta; el resto del sobre lo pone la outbox. */
export interface EnqueueEventParams {
  eventType: EVENT_TYPE_ENUM;
  /** Tópico de Kafka en el que se publicará. */
  topic: string;
  /** Cuerpo del evento, sin `eventId`/`occurredAt`/`version`. */
  body: Record<string, unknown>;
  /** Actor del evento (normalmente un `userId`). */
  from?: string | null;
}

/**
 * Cuántos eventos atrasados se intentan publicar en cada oportunidad. Un tope bajo a propósito:
 * esto corre en el camino de una petición HTTP que ya terminó su trabajo, y no debe convertirse en
 * un barrido largo por haberse acumulado el histórico.
 */
const PENDING_PUBLICATION_BATCH = 20;

/**
 * Outbox transaccional de los eventos de dominio (historia "Implementar flujo de aprobación previo
 * al proceso de firma").
 *
 * El problema que resuelve: hasta ahora el productor publicaba en Kafka y *después* registraba el
 * evento, fuera de la transacción que cambiaba el estado. Entre una cosa y la otra caben dos
 * fallos distintos —el documento se mueve y el evento no se publica, o se publica un evento de un
 * cambio que la transacción terminó deshaciendo— y ninguno de los dos deja rastro de que pasó.
 *
 * Con la outbox son dos pasos con una garantía cada uno:
 *
 *  1. `enqueue` escribe la fila **con el `manager` de la transacción del llamador**. Si esa
 *     transacción revierte, el evento desaparece con ella: nunca se anuncia algo que no ocurrió.
 *  2. `flush` publica lo pendiente **después** del commit. Si falla, la fila se queda con
 *     `published_at` en NULL y el siguiente `flush` la reintenta: nunca se pierde algo que sí
 *     ocurrió.
 *
 * Lo que esto garantiza es entrega *al menos una vez*, no exactamente una — un fallo entre el
 * publish y el marcado republica el evento. Por eso los consumidores son idempotentes por
 * `eventId` (ver `IdempotencyService`); las dos piezas son una sola decisión y no se pueden
 * adoptar por separado.
 *
 * **Sin planificador.** El reintento es perezoso: cada `flush` arrastra además los eventos viejos
 * que quedaron sin publicar. Es el mismo criterio de `RetryPendingSealUseCase` —"el trabajo se
 * hace cuando a alguien le importa el resultado"— y evita meter una pieza en movimiento que el
 * proyecto no tiene. La contrapartida, explícita: en un sistema totalmente inactivo, un evento
 * pendiente espera hasta el siguiente evento de cualquier tipo.
 */
@Injectable()
export class OutboxService {
  private readonly logger = new Logger(OutboxService.name);

  constructor(
    @InjectRepository(EventEntity)
    private readonly eventRepository: Repository<EventEntity>,
    private readonly kafkaProducer: KafkaProducerService,
  ) {}

  /**
   * Registra un evento dentro de la transacción del llamador, sin publicarlo todavía.
   *
   * @param manager - `EntityManager` de la transacción que está cambiando el estado. Es
   *   obligatorio a propósito: llamar a esto fuera de una transacción no tendría ninguna de las
   *   garantías por las que existe la outbox.
   * @param params - Tipo, tópico, cuerpo y actor del evento.
   * @returns La fila ya escrita, con su `id` — que es el `eventId` del sobre.
   *
   * @throws {QueryFailedError} Si la inserción falla; propaga y revierte la transacción del
   *   llamador, que es lo correcto: sin evento registrado, el cambio de estado no debe confirmarse.
   *
   * @example
   * ```ts
   * const event = await outbox.enqueue(manager, {
   *   eventType: EVENT_TYPE_ENUM.DOCUMENT_APPROVED,
   *   topic: DOCUMENT_KAFKA_TOPICS.APPROVED,
   *   body: { documentId, collaboratorId, fileName },
   *   from: actorUserId,
   * });
   * ```
   */
  async enqueue(
    manager: EntityManager,
    { eventType, topic, body, from }: EnqueueEventParams,
  ): Promise<EventEntity> {
    const repository = manager.getRepository(EventEntity);

    return repository.save(
      repository.create({
        eventType,
        /**
         * El sobre completo, no un resumen: republicar no puede depender de saber reconstruirlo,
         * porque quien republica es un `flush` posterior que ya no tiene el contexto del cambio.
         * `topic` viaja dentro por lo mismo.
         */
        metadata: { ...body, topic },
        from: from ?? null,
        version: EVENT_CONTRACT_VERSION,
        publishedAt: null,
      }),
    );
  }

  /**
   * Publica en Kafka los eventos que quedaron pendientes y los marca como publicados.
   *
   * Se llama DESPUÉS de confirmar la transacción. Es best-effort por diseño: lo que no se consiga
   * publicar se queda pendiente y lo reintenta el siguiente `flush`, así que un Kafka caído no
   * devuelve un error a quien acaba de aprobar un documento que ya quedó aprobado.
   *
   * @returns Cuántos eventos se publicaron.
   *
   * @throws Nada: los fallos se registran en el log y dejan la fila pendiente.
   *
   * @example
   * ```ts
   * await outbox.flush(); // tras el commit de la transacción
   * ```
   */
  async flush(): Promise<number> {
    const pending = await this.eventRepository.find({
      where: { publishedAt: IsNull() },
      order: { createdAt: 'ASC' },
      take: PENDING_PUBLICATION_BATCH,
    });

    let published = 0;
    for (const event of pending) {
      try {
        const { topic, ...body } = (event.metadata ?? {}) as Record<
          string,
          unknown
        > & { topic?: string };

        if (!topic) {
          /**
           * Filas anteriores a la outbox: se registraban después de publicar y sin `topic`. No hay
           * nada que republicar, y dejarlas pendientes para siempre haría que cada `flush` las
           * volviera a leer.
           */
          await this.eventRepository.update(event.id, {
            publishedAt: new Date(),
          });
          continue;
        }

        this.kafkaProducer.emit(topic, {
          eventId: event.id,
          occurredAt: event.createdAt.toISOString(),
          version: event.version,
          actorUserId: event.from,
          ...body,
        });

        await this.eventRepository.update(event.id, {
          publishedAt: new Date(),
        });
        published += 1;
      } catch (error) {
        this.logger.error(
          `Error publicando el evento ${event.id} (${event.eventType}); queda pendiente para el siguiente intento: ${error}`,
        );
      }
    }

    return published;
  }
}
