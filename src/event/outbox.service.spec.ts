import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { KafkaProducerService } from 'src/kafka/kafka-producer.service';

import { EventEntity } from './entities/event.entity';
import { ProcessedEventEntity } from './entities/processed-event.entity';
import { EVENT_TYPE_ENUM } from './enums/event-type.enum';
import { IdempotencyService } from './idempotency.service';
import { EVENT_CONTRACT_VERSION, OutboxService } from './outbox.service';

/**
 * Historia "Implementar flujo de aprobación previo al proceso de firma": la outbox transaccional
 * y la idempotencia son una sola decisión —la primera garantiza entrega *al menos una vez*, y la
 * segunda es lo que hace que eso sea seguro— así que se prueban juntas.
 */
describe('outbox transaccional', () => {
  let outbox: OutboxService;
  let idempotency: IdempotencyService;

  let eventRepository: Record<string, jest.Mock>;
  let processedEventRepository: Record<string, jest.Mock>;
  let kafkaProducer: Record<string, jest.Mock>;
  let managedEventRepository: Record<string, jest.Mock>;
  let insertBuilder: Record<string, jest.Mock>;

  /** `EntityManager` de la transacción del llamador, reducido a lo que la outbox usa. */
  const manager = {
    getRepository: () => managedEventRepository,
  } as never;

  function givenPendingEvent(overrides: Partial<EventEntity> = {}) {
    return {
      id: 'event-1',
      eventType: EVENT_TYPE_ENUM.DOCUMENT_APPROVED,
      metadata: {
        topic: 'document.approved',
        documentId: 'doc-1',
        collaboratorId: 'collab-reviewer',
      },
      from: 'user-reviewer',
      version: 1,
      publishedAt: null,
      createdAt: new Date('2026-09-19T10:00:00.000Z'),
      ...overrides,
    } as EventEntity;
  }

  beforeEach(async () => {
    managedEventRepository = {
      create: jest.fn((data: unknown) => data),
      save: jest.fn(async (data: unknown) => ({ id: 'event-1', ...(data as object) })),
    };
    eventRepository = {
      find: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    insertBuilder = {
      insert: jest.fn(() => insertBuilder),
      into: jest.fn(() => insertBuilder),
      values: jest.fn(() => insertBuilder),
      orIgnore: jest.fn(() => insertBuilder),
      execute: jest.fn().mockResolvedValue({ raw: [{ event_id: 'event-1' }] }),
    };
    processedEventRepository = {
      createQueryBuilder: jest.fn(() => insertBuilder),
    };
    kafkaProducer = { emit: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OutboxService,
        IdempotencyService,
        { provide: getRepositoryToken(EventEntity), useValue: eventRepository },
        {
          provide: getRepositoryToken(ProcessedEventEntity),
          useValue: processedEventRepository,
        },
        { provide: KafkaProducerService, useValue: kafkaProducer },
      ],
    }).compile();

    outbox = module.get(OutboxService);
    idempotency = module.get(IdempotencyService);
  });

  describe('enqueue', () => {
    /**
     * Lo que hace transaccional a la outbox: la fila se escribe con el repositorio del manager que
     * le pasan, no con el suyo. Si esa transacción revierte, el evento se va con ella.
     */
    it('escribe con el repositorio de la transacción del llamador, no con el propio', async () => {
      await outbox.enqueue(manager, {
        eventType: EVENT_TYPE_ENUM.DOCUMENT_APPROVED,
        topic: 'document.approved',
        body: { documentId: 'doc-1' },
        from: 'user-1',
      });

      expect(managedEventRepository.save).toHaveBeenCalled();
      expect(eventRepository.update).not.toHaveBeenCalled();
    });

    it('nace sin publicar y con la versión del contrato', async () => {
      await outbox.enqueue(manager, {
        eventType: EVENT_TYPE_ENUM.DOCUMENT_APPROVED,
        topic: 'document.approved',
        body: { documentId: 'doc-1' },
      });

      expect(managedEventRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          publishedAt: null,
          version: EVENT_CONTRACT_VERSION,
        }),
      );
    });

    /** Republicar no puede depender de reconstruir el sobre: se guarda entero, tópico incluido. */
    it('guarda el sobre completo, con el tópico dentro', async () => {
      await outbox.enqueue(manager, {
        eventType: EVENT_TYPE_ENUM.DOCUMENT_APPROVED,
        topic: 'document.approved',
        body: { documentId: 'doc-1', collaboratorId: 'collab-1' },
      });

      expect(managedEventRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: {
            topic: 'document.approved',
            documentId: 'doc-1',
            collaboratorId: 'collab-1',
          },
        }),
      );
    });
  });

  describe('flush', () => {
    it('publica lo pendiente con su sobre y lo marca como publicado', async () => {
      eventRepository.find.mockResolvedValue([givenPendingEvent()]);

      const published = await outbox.flush();

      expect(kafkaProducer.emit).toHaveBeenCalledWith(
        'document.approved',
        expect.objectContaining({
          eventId: 'event-1',
          occurredAt: '2026-09-19T10:00:00.000Z',
          version: 1,
          actorUserId: 'user-reviewer',
          documentId: 'doc-1',
          collaboratorId: 'collab-reviewer',
        }),
      );
      expect(eventRepository.update).toHaveBeenCalledWith('event-1', {
        publishedAt: expect.any(Date),
      });
      expect(published).toBe(1);
    });

    /**
     * Lo que hace reintentable la publicación: si Kafka falla, la fila se queda sin marcar y el
     * siguiente `flush` vuelve por ella. Y no se propaga el error, porque el cambio de estado que
     * originó el evento ya está confirmado.
     */
    it('si la publicación falla, deja el evento pendiente y no lanza', async () => {
      eventRepository.find.mockResolvedValue([givenPendingEvent()]);
      kafkaProducer.emit.mockImplementation(() => {
        throw new Error('Kafka caído');
      });

      const published = await outbox.flush();

      expect(published).toBe(0);
      expect(eventRepository.update).not.toHaveBeenCalled();
    });

    /**
     * Filas anteriores a la outbox: se registraban después de publicar y sin tópico. No hay nada
     * que republicar, y dejarlas pendientes haría que cada `flush` las volviera a leer para
     * siempre.
     */
    it('descarta las filas antiguas sin tópico marcándolas como publicadas', async () => {
      eventRepository.find.mockResolvedValue([
        givenPendingEvent({ metadata: { documentId: 'doc-viejo' } }),
      ]);

      const published = await outbox.flush();

      expect(kafkaProducer.emit).not.toHaveBeenCalled();
      expect(eventRepository.update).toHaveBeenCalledWith('event-1', {
        publishedAt: expect.any(Date),
      });
      expect(published).toBe(0);
    });
  });

  describe('idempotencia del consumo', () => {
    it('reclama el evento la primera vez', async () => {
      await expect(idempotency.claim('event-1', 'document-events')).resolves.toBe(
        true,
      );
    });

    /** La reentrega del mismo evento no inserta nada, y eso es lo que la delata. */
    it('descarta la reentrega del mismo evento para el mismo consumidor', async () => {
      insertBuilder.execute.mockResolvedValue({ raw: [] });

      await expect(idempotency.claim('event-1', 'document-events')).resolves.toBe(
        false,
      );
    });

    /**
     * Un evento sin `eventId` —publicado por el camino directo, o anterior a la outbox— no se
     * puede deduplicar. Dejarlo pasar arriesga un duplicado; bloquearlo garantizaría perderlo.
     */
    it('deja pasar un evento sin eventId', async () => {
      await expect(
        idempotency.claim(undefined, 'document-events'),
      ).resolves.toBe(true);
      expect(processedEventRepository.createQueryBuilder).not.toHaveBeenCalled();
    });

    it('ante un fallo de base, procesa igual antes que perder el evento', async () => {
      insertBuilder.execute.mockRejectedValue(new Error('base caída'));

      await expect(idempotency.claim('event-1', 'document-events')).resolves.toBe(
        true,
      );
    });
  });
});
