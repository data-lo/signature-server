import type { Response } from 'express';

import { IS_SKIP_JWT_KEY } from 'src/auth/decorators/skip-jwt-auth.decorator';

import { MetricsController } from './metrics.controller';
import { MetricsService } from './metrics.service';

describe('MetricsController', () => {
  const service = new MetricsService({ enabled: true, path: '/metrics' });
  const controller = new MetricsController(service);

  it('devuelve el registro con el Content-Type de Prometheus', async () => {
    const setHeader = jest.fn();

    const body = await controller.getMetrics({
      setHeader,
    } as unknown as Response);

    expect(setHeader).toHaveBeenCalledWith(
      'Content-Type',
      service.getContentType(),
    );
    expect(body).toContain('# TYPE http_server_requests_total counter');
  });

  it('no exige JWT: Prometheus consulta sin credenciales', () => {
    expect(
      Reflect.getMetadata(
        IS_SKIP_JWT_KEY,
        MetricsController.prototype.getMetrics,
      ),
    ).toBe(true);
  });
});
