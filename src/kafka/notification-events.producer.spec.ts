import { EventEntity } from 'src/event/entities/event.entity';
import { EVENT_TYPE_ENUM } from 'src/event/enums/event-type.enum';
import { OutboxService } from 'src/event/outbox.service';

import { NotificationEventsProducer } from './notification-events.producer';
import {
  NOTIFICATION_KAFKA_TOPICS,
  type NotificationEventPayload,
} from './notification-events.topics';

/**
 * `enqueueCreated` se prueba con una `OutboxService` REAL sobre una tabla `events` en memoria: lo
 * que importa no es que llame a `enqueue`, sino que lo que deja en la outbox sea exactamente lo
 * que `flush` publica y lo que `NotificationEventsConsumer` sabe leer.
 */
describe('NotificationEventsProducer.enqueueCreated', () => {
  let rows: EventEntity[];
  let transactionRepository: Record<string, jest.Mock>;
  let manager: { getRepository: jest.Mock };
  let kafkaProducer: { emit: jest.Mock };
  let outbox: OutboxService;
  let producer: NotificationEventsProducer;

  const params = {
    notificationId: 'notification-1',
    documentId: 'doc-1',
    collaboratorId: 'collaborator-1',
    actorType: 'WATCHER',
    notificationChannelSource: 'EMAIL',
    actorUserId: 'creator-1',
  };

  beforeEach(() => {
    rows = [];
    transactionRepository = {
      create: jest.fn((data: Partial<EventEntity>) => data),
      save: jest.fn(async (data: Partial<EventEntity>) => {
        const row = {
          ...data,
          id: `event-${rows.length + 1}`,
          createdAt: new Date('2026-10-07T12:00:00.000Z'),
        } as EventEntity;
        rows.push(row);
        return row;
      }),
    };
    manager = { getRepository: jest.fn(() => transactionRepository) };

    const eventRepository = {
      find: jest.fn(async () => rows.filter((row) => !row.publishedAt)),
      update: jest.fn(async (id: string, changes: Partial<EventEntity>) => {
        Object.assign(rows.find((row) => row.id === id)!, changes);
      }),
    };
    kafkaProducer = { emit: jest.fn() };
    outbox = new OutboxService(
      eventRepository as never,
      kafkaProducer as never,
    );
    producer = new NotificationEventsProducer(
      { emit: jest.fn() } as never,
      { create: jest.fn() } as never,
      outbox,
    );
  });

  it('escribe la fila con el manager de la transacción y sin publicarla todavía', async () => {
    await producer.enqueueCreated(manager as never, params);

    expect(manager.getRepository).toHaveBeenCalledWith(EventEntity);
    expect(rows).toEqual([
      expect.objectContaining({
        eventType: EVENT_TYPE_ENUM.NOTIFICATION_CREATED,
        from: 'creator-1',
        publishedAt: null,
      }),
    ]);
    expect(kafkaProducer.emit).not.toHaveBeenCalled();
  });

  it('tras el commit, flush publica en notification.created el cuerpo que lee el consumidor', async () => {
    await producer.enqueueCreated(manager as never, params);

    await outbox.flush();

    expect(kafkaProducer.emit).toHaveBeenCalledTimes(1);
    const [topic, message] = kafkaProducer.emit.mock.calls[0];
    expect(topic).toBe(NOTIFICATION_KAFKA_TOPICS.CREATED);
    const payload: NotificationEventPayload = message;
    expect(payload).toMatchObject({
      notificationId: 'notification-1',
      documentId: 'doc-1',
      collaboratorId: 'collaborator-1',
      actorType: 'WATCHER',
      notificationChannelSource: 'EMAIL',
      timestamp: expect.any(String),
    });
    expect(message).toMatchObject({
      eventId: 'event-1',
      actorUserId: 'creator-1',
    });
    // El tópico viaja dentro de la fila para poder republicar, pero no dentro del mensaje.
    expect(message).not.toHaveProperty('topic');
    expect(rows[0].publishedAt).toBeInstanceOf(Date);
  });

  it('un segundo flush no vuelve a publicar lo ya publicado', async () => {
    await producer.enqueueCreated(manager as never, params);

    await outbox.flush();
    await outbox.flush();

    expect(kafkaProducer.emit).toHaveBeenCalledTimes(1);
  });

  it('si escribir la fila falla, propaga el error para revertir la transacción del llamador', async () => {
    transactionRepository.save.mockRejectedValue(new Error('events caída'));

    await expect(
      producer.enqueueCreated(manager as never, params),
    ).rejects.toThrow('events caída');
  });
});
