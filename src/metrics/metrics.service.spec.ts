import { resolveMetricsOptions } from './metrics.constants';
import { MetricsService } from './metrics.service';

describe('MetricsService', () => {
  let service: MetricsService;

  beforeEach(() => {
    service = new MetricsService({ enabled: true, path: '/metrics' });
  });

  it('activa las métricas de runtime de Node al estar habilitado', async () => {
    const body = await service.getMetrics();

    expect(body).toContain('process_cpu_seconds_total');
    expect(body).toContain('nodejs_heap_size_used_bytes');
    expect(body).toContain('nodejs_eventloop_lag_seconds');
    expect(body).toContain('nodejs_gc_duration_seconds');
  });

  it('no activa las métricas de runtime al estar deshabilitado', async () => {
    const disabled = new MetricsService({ enabled: false, path: '/metrics' });

    expect(await disabled.getMetrics()).not.toContain(
      'process_cpu_seconds_total',
    );
  });

  it('usa un registro por instancia: dos aplicaciones no chocan ni comparten valores', async () => {
    service.recordHttpRequest({
      method: 'GET',
      route: '/a',
      statusCode: 200,
      durationSeconds: 0.1,
    });

    const other = new MetricsService({ enabled: true, path: '/metrics' });

    expect(await other.getMetrics()).not.toContain('route="/a"');
  });

  describe('recordHttpRequest', () => {
    it('una petición exitosa suma al contador y al histograma, no a los errores', async () => {
      service.recordHttpRequest({
        method: 'GET',
        route: '/api/v1/document/:id',
        statusCode: 200,
        durationSeconds: 0.2,
      });

      const body = await service.getMetrics();
      const labels =
        'method="GET",route="/api/v1/document/:id",status_code="200"';
      expect(body).toContain(`http_server_requests_total{${labels}} 1`);
      expect(body).toContain(
        `http_server_request_duration_seconds_count{${labels}} 1`,
      );
      expect(body).toContain(
        `http_server_request_duration_seconds_sum{${labels}} 0.2`,
      );
      expect(body).not.toContain('http_server_errors_total{');
    });

    it.each([400, 404, 499, 500, 503])(
      'un %i suma al contador de errores',
      async (statusCode) => {
        service.recordHttpRequest({
          method: 'POST',
          route: '/x',
          statusCode,
          durationSeconds: 0.01,
          errorType: 'SomeException',
        });

        expect(await service.getMetrics()).toContain(
          `http_server_errors_total{route="/x",status_code="${statusCode}",error_type="SomeException"} 1`,
        );
      },
    );

    it('sin tipo de excepción, el error cuenta como UnknownError', async () => {
      service.recordHttpRequest({
        method: 'POST',
        route: '/x',
        statusCode: 422,
        durationSeconds: 0.01,
      });

      expect(await service.getMetrics()).toContain(
        'http_server_errors_total{route="/x",status_code="422",error_type="UnknownError"} 1',
      );
    });

    it.each([
      '/health',
      '/metrics',
      '/api/v1/docs',
      '/api/v1/docs-json',
      '/api/v1/docs/swagger-ui.css',
      '/api/v1/integration/docs',
      '/api/v1/integration/docs-json',
    ])('descarta %s', async (route) => {
      service.recordHttpRequest({
        method: 'GET',
        route,
        statusCode: 200,
        durationSeconds: 0.01,
      });

      expect(await service.getMetrics()).not.toContain(`route="${route}"`);
    });

    it('descarta las solicitudes OPTIONS', async () => {
      service.recordHttpRequest({
        method: 'OPTIONS',
        route: '/x',
        statusCode: 204,
        durationSeconds: 0.01,
      });

      expect(await service.getMetrics()).not.toContain('route="/x"');
    });

    it('no confunde una ruta de negocio con Swagger', () => {
      expect(
        service.shouldMeasure('GET', '/api/v1/integration/documents'),
      ).toBe(true);
      expect(service.shouldMeasure('GET', '/api/v1/document')).toBe(true);
    });

    it('apagado no mide nada', async () => {
      const disabled = new MetricsService({ enabled: false, path: '/metrics' });

      disabled.recordHttpRequest({
        method: 'GET',
        route: '/x',
        statusCode: 200,
        durationSeconds: 0.01,
      });
      disabled.trackInFlightRequest('GET', '/x')();

      expect(await disabled.getMetrics()).not.toContain('route="/x"');
    });

    it('descarta la ruta configurada en METRICS_PATH, no sólo la de por defecto', async () => {
      const custom = new MetricsService({
        enabled: true,
        path: '/internal/metrics',
      });

      custom.recordHttpRequest({
        method: 'GET',
        route: '/internal/metrics',
        statusCode: 200,
        durationSeconds: 0.01,
      });

      expect(await custom.getMetrics()).not.toContain(
        'route="/internal/metrics"',
      );
    });
  });

  describe('trackInFlightRequest', () => {
    it('suma al entrar y descuenta al liberar', async () => {
      const release = service.trackInFlightRequest('GET', '/x');

      const series = 'http_server_in_flight_requests{method="GET",route="/x"}';
      expect(await service.getMetrics()).toContain(`${series} 1`);

      release();

      expect(await service.getMetrics()).toContain(`${series} 0`);
    });

    it('no mide /health', async () => {
      service.trackInFlightRequest('GET', '/health')();

      expect(await service.getMetrics()).not.toContain('route="/health"');
    });
  });

  describe('creación de métricas', () => {
    it('una métrica nueva queda en el mismo registro', async () => {
      service
        .createCounter({
          name: 'documents_signed_total',
          help: 'Documentos firmados.',
          labelNames: ['signature_type'],
        })
        .inc({ signature_type: 'FIEL' });
      service.createGauge({ name: 'queue_size', help: 'Cola.' }).set(3);
      service
        .createHistogram({
          name: 'seal_seconds',
          help: 'Sellado.',
          buckets: [1],
        })
        .observe(0.5);

      const body = await service.getMetrics();
      expect(body).toContain('documents_signed_total{signature_type="FIEL"} 1');
      expect(body).toContain('queue_size 3');
      expect(body).toContain('seal_seconds_count 1');
    });

    it.each([
      'user_id',
      'organization_id',
      'document_id',
      'email',
      'correo',
      'curp',
      'CURP',
      'ip',
      'token',
      'message',
    ])('rechaza el label prohibido %s', (label) => {
      const configuration = {
        name: 'forbidden_metric',
        help: 'Prohibida.',
        labelNames: [label],
      };

      expect(() => service.createCounter(configuration)).toThrow(label);
      expect(() => service.createGauge(configuration)).toThrow(label);
      expect(() => service.createHistogram(configuration)).toThrow(label);
    });
  });
});

describe('resolveMetricsOptions', () => {
  it('sin variables queda apagado y en /metrics', () => {
    expect(resolveMetricsOptions({})).toEqual({
      enabled: false,
      path: '/metrics',
    });
  });

  it('sólo `true` lo activa', () => {
    expect(resolveMetricsOptions({ METRICS_ENABLED: 'true' }).enabled).toBe(
      true,
    );
    expect(resolveMetricsOptions({ METRICS_ENABLED: 'false' }).enabled).toBe(
      false,
    );
    expect(resolveMetricsOptions({ METRICS_ENABLED: '1' }).enabled).toBe(false);
  });

  it('normaliza las diagonales de la ruta', () => {
    expect(
      resolveMetricsOptions({ METRICS_PATH: 'internal/metrics/' }).path,
    ).toBe('/internal/metrics');
  });

  it.each(['/', '/health', '/metrics/:id', '/metrics?x=1', '/*'])(
    'rechaza la ruta %s',
    (path) => {
      expect(() => resolveMetricsOptions({ METRICS_PATH: path })).toThrow(
        'METRICS_PATH',
      );
    },
  );
});
