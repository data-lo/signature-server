import { WebhookEventEntity } from 'src/webhooks/entities/webhook-event.entity';
import { Repository } from 'typeorm';

import { MetricsService } from './metrics.service';
import { WebhookBacklogMetricsCollector } from './webhook-backlog-metrics.collector';
import { WebhookMetricsService } from './webhook-metrics.service';

function buildCollector(enabled = true) {
  const metrics = new MetricsService({ enabled, path: '/metrics' });
  const builder = {
    select: jest.fn().mockReturnThis(),
    addSelect: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    groupBy: jest.fn().mockReturnThis(),
    addGroupBy: jest.fn().mockReturnThis(),
    getRawMany: jest.fn().mockResolvedValue([]),
  };
  const repository = {
    createQueryBuilder: jest.fn(() => builder),
    update: jest.fn(),
    save: jest.fn(),
    delete: jest.fn(),
  };
  const collector = new WebhookBacklogMetricsCollector(
    repository as unknown as Repository<WebhookEventEntity>,
    new WebhookMetricsService(metrics),
  );
  return { collector, metrics, builder, repository };
}

describe('WebhookBacklogMetricsCollector', () => {
  it('publica cantidad y antigüedad de las filas RECEIVED y FAILED', async () => {
    const { collector, metrics, builder } = buildCollector();
    builder.getRawMany.mockResolvedValue([
      {
        provider: 'STRIPE',
        status: 'FAILED',
        pending: '3',
        oldestSeconds: '120.5',
      },
      {
        provider: 'DIDIT',
        status: 'RECEIVED',
        pending: '1',
        oldestSeconds: '7',
      },
    ]);

    await collector.collect();

    const body = await metrics.getMetrics();
    expect(body).toContain(
      'webhook_events_pending{provider="STRIPE",status="FAILED"} 3',
    );
    expect(body).toContain(
      'webhook_oldest_pending_seconds{provider="STRIPE",status="FAILED"} 120.5',
    );
    expect(body).toContain(
      'webhook_events_pending{provider="DIDIT",status="RECEIVED"} 1',
    );
    expect(body).toContain(
      'webhook_oldest_pending_seconds{provider="DIDIT",status="RECEIVED"} 7',
    );
  });

  it('publica en cero las combinaciones sin filas', async () => {
    const { collector, metrics } = buildCollector();

    await collector.collect();

    const body = await metrics.getMetrics();
    for (const provider of ['DIDIT', 'STRIPE']) {
      for (const status of ['RECEIVED', 'FAILED']) {
        const labels = `{provider="${provider}",status="${status}"}`;
        expect(body).toContain(`webhook_events_pending${labels} 0`);
        expect(body).toContain(`webhook_oldest_pending_seconds${labels} 0`);
      }
    }
  });

  it('vuelve a cero una serie cuyas filas ya se resolvieron', async () => {
    const { collector, metrics, builder } = buildCollector();
    builder.getRawMany.mockResolvedValueOnce([
      {
        provider: 'STRIPE',
        status: 'FAILED',
        pending: '3',
        oldestSeconds: '120',
      },
    ]);

    await collector.collect();
    await collector.collect();

    const body = await metrics.getMetrics();
    const labels = '{provider="STRIPE",status="FAILED"}';
    expect(body).toContain(`webhook_events_pending${labels} 0`);
    expect(body).toContain(`webhook_oldest_pending_seconds${labels} 0`);
  });

  it('sólo considera RECEIVED y FAILED, y deja fuera los rechazos de auditoría', async () => {
    const { collector, builder } = buildCollector();

    await collector.collect();

    expect(builder.where).toHaveBeenCalledWith(
      'event.processingStatus IN (:...statuses)',
      { statuses: ['RECEIVED', 'FAILED'] },
    );
    expect(builder.andWhere).toHaveBeenCalledWith(
      'event.providerEventId IS NOT NULL',
    );
  });

  it('no modifica ninguna fila', async () => {
    const { collector, repository } = buildCollector();

    await collector.collect();

    expect(repository.update).not.toHaveBeenCalled();
    expect(repository.save).not.toHaveBeenCalled();
    expect(repository.delete).not.toHaveBeenCalled();
  });

  it('si la consulta falla no lanza y conserva el último valor en vez de publicar cero', async () => {
    const { collector, metrics, builder } = buildCollector();
    builder.getRawMany.mockResolvedValueOnce([
      {
        provider: 'STRIPE',
        status: 'FAILED',
        pending: '3',
        oldestSeconds: '120',
      },
    ]);
    await collector.collect();
    builder.getRawMany.mockRejectedValueOnce(new Error('sin conexión'));

    await expect(collector.collect()).resolves.toBeUndefined();

    expect(await metrics.getMetrics()).toContain(
      'webhook_events_pending{provider="STRIPE",status="FAILED"} 3',
    );
  });

  it('con las métricas apagadas no consulta la base', async () => {
    const { collector, repository } = buildCollector(false);

    await collector.collect();

    expect(repository.createQueryBuilder).not.toHaveBeenCalled();
  });

  it('recolecta al arrancar para no dejar el primer minuto sin series', async () => {
    const { collector, metrics } = buildCollector();

    await collector.onApplicationBootstrap();

    expect(await metrics.getMetrics()).toContain(
      'webhook_events_pending{provider="DIDIT",status="FAILED"} 0',
    );
  });
});
