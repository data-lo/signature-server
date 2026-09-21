import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { ProcessedEventEntity } from './entities/processed-event.entity';

/**
 * Hace idempotente el consumo de eventos (historia "Implementar flujo de aprobación previo al
 * proceso de firma").
 *
 * Kafka entrega *al menos una vez*, y la outbox lo refuerza: un fallo entre publicar y marcar la
 * fila hace que el mismo evento se republique. Sin esto, un evento reentregado encadenaría dos
 * veces la misma transacción de auditoría o mandaría dos veces el mismo correo.
 *
 * La marca se toma ANTES de hacer el trabajo y no después. Es deliberado: reclamar primero
 * convierte una doble entrega simultánea en una carrera que resuelve la llave primaria de
 * `processed_events` —sólo una inserción gana—, mientras que marcar al final dejaría a las dos
 * entregas trabajando en paralelo, que es justo lo que se quiere evitar. El precio, explícito: si
 * el proceso muere entre el reclamo y el trabajo, ese evento no se reintenta. Para lo que hoy
 * consumen estos eventos —auditoría y correos, ninguno crítico para el estado del documento— es
 * el intercambio correcto; el estado crítico lo cambian los casos de uso en su transacción, nunca
 * un consumidor de Kafka.
 */
@Injectable()
export class IdempotencyService {
  private readonly logger = new Logger(IdempotencyService.name);

  constructor(
    @InjectRepository(ProcessedEventEntity)
    private readonly processedEventRepository: Repository<ProcessedEventEntity>,
  ) {}

  /**
   * Reclama un evento para un consumidor.
   *
   * @param eventId - `eventId` del sobre. Si viene vacío —un evento publicado antes de la outbox,
   *   o por un productor que todavía no la usa— se deja pasar: no hay con qué deduplicar, y
   *   bloquear el procesamiento sería peor que arriesgar un duplicado.
   * @param consumer - Nombre estable del consumidor.
   * @returns `true` si este proceso se quedó con el evento y debe trabajarlo; `false` si ya lo
   *   había procesado (o lo está procesando) alguien más.
   *
   * @throws Nada: un fallo de base al reclamar se registra y devuelve `true`, porque perder el
   *   procesamiento de un evento es peor que repetirlo.
   *
   * @example
   * ```ts
   * if (!(await idempotency.claim(payload.eventId, 'document-events'))) return;
   * ```
   */
  async claim(
    eventId: string | undefined | null,
    consumer: string,
  ): Promise<boolean> {
    if (!eventId) return true;

    try {
      const result = await this.processedEventRepository
        .createQueryBuilder()
        .insert()
        .into(ProcessedEventEntity)
        .values({ eventId, consumer })
        .orIgnore()
        .execute();

      /**
       * `orIgnore()` no lanza cuando la fila ya existe: lo que lo delata es que no insertó nada.
       * Postgres devuelve las filas realmente insertadas en `raw`, así que un arreglo vacío
       * significa "ya estaba".
       */
      const inserted = Array.isArray(result.raw) ? result.raw.length : 0;

      if (inserted === 0) {
        this.logger.log(
          `Evento ${eventId} ya procesado por '${consumer}': se descarta la reentrega`,
        );
      }

      return inserted > 0;
    } catch (error) {
      this.logger.error(
        `Error reclamando el evento ${eventId} para '${consumer}'; se procesa de todos modos: ${error}`,
      );
      return true;
    }
  }
}
