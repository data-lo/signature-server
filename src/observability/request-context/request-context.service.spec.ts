import { setTimeout as delay } from 'timers/promises';

import { RequestContext } from './request-context.interface';
import { RequestContextService } from './request-context.service';

/** Contexto de prueba con el `requestId` indicado. */
function contextWith(requestId: string): RequestContext {
  return Object.freeze({
    requestId,
    method: 'POST',
    path: '/api/v1/integration/documents',
    startedAt: '2026-11-14T10:00:00.000Z',
  });
}

describe('RequestContextService', () => {
  const service = new RequestContextService();

  it('fuera de una petición no hay contexto', () => {
    expect(service.get()).toBeUndefined();
    expect(service.getRequestId()).toBeUndefined();
  });

  it('dentro de run expone el contexto y su requestId', () => {
    const context = contextWith('req-1');
    service.run(context, () => {
      expect(service.get()).toBe(context);
      expect(service.getRequestId()).toBe('req-1');
    });
    expect(service.get()).toBeUndefined();
  });

  it('devuelve lo que devuelve el callback', () => {
    expect(service.run(contextWith('req-1'), () => 42)).toBe(42);
  });

  it('el contexto sobrevive a await, timers y promesas encadenadas', async () => {
    const seen = await service.run(contextWith('req-async'), async () => {
      const ids: (string | undefined)[] = [service.getRequestId()];
      await delay(5);
      ids.push(service.getRequestId());
      await new Promise<void>((resolve) => setImmediate(resolve));
      ids.push(service.getRequestId());
      ids.push(await Promise.resolve().then(() => service.getRequestId()));
      return ids;
    });
    expect(seen).toEqual(['req-async', 'req-async', 'req-async', 'req-async']);
  });

  it('todas las instancias leen el mismo almacén', () => {
    const other = new RequestContextService();
    service.run(contextWith('req-shared'), () => {
      expect(other.getRequestId()).toBe('req-shared');
    });
  });

  it('un run anidado no pisa el contexto exterior', () => {
    service.run(contextWith('outer'), () => {
      service.run(contextWith('inner'), () => {
        expect(service.getRequestId()).toBe('inner');
      });
      expect(service.getRequestId()).toBe('outer');
    });
  });

  it('ejecuciones concurrentes no comparten contexto', async () => {
    const ids = Array.from({ length: 50 }, (_, index) => `req-${index}`);
    const results = await Promise.all(
      ids.map((id, index) =>
        service.run(contextWith(id), async () => {
          // Esperas desordenadas para que las ejecuciones se intercalen.
          await delay((index * 7) % 13);
          const before = service.getRequestId();
          await delay((index * 3) % 5);
          return [before, service.getRequestId()];
        }),
      ),
    );
    expect(results).toEqual(ids.map((id) => [id, id]));
  });
});
