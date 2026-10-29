import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { KafkaModule } from 'src/kafka/kafka.module';

import { EventEntity } from './entities/event.entity';
import { ProcessedEventEntity } from './entities/processed-event.entity';
import { EventService } from './event.service';
import { IdempotencyService } from './idempotency.service';
import { OutboxService } from './outbox.service';

/**
 * Eventos de dominio: su traza en Postgres, la outbox transaccional con la que se publican y la
 * marca de idempotencia con la que se consumen.
 *
 * El `forwardRef` sobre `KafkaModule` es real y no preventivo: `OutboxService` necesita
 * `KafkaProducerService` para publicar, y `KafkaModule` ya importaba `EventModule` porque su
 * productor registra la traza de cada evento. Es un ciclo entre dos módulos que se necesitan por
 * razones distintas —publicar y registrar— y que no se rompe separándolos: quien publica tiene que
 * saber registrar, y quien registra tiene que saber publicar.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([EventEntity, ProcessedEventEntity]),
    forwardRef(() => KafkaModule),
  ],
  providers: [EventService, OutboxService, IdempotencyService],
  exports: [EventService, OutboxService, IdempotencyService],
})
export class EventModule {}
