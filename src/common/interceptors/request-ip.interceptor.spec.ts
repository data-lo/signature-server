import { lastValueFrom, of, Subject, throwError } from 'rxjs';
import {
  BadRequestException,
  NotFoundException,
  type CallHandler,
  type ExecutionContext,
} from '@nestjs/common';
import { MetricsService } from 'src/metrics/metrics.service';
import { RequestIpInterceptor } from './request-ip.interceptor';

function buildContext(
  request: any,
  response: { statusCode: number } = { statusCode: 200 },
  type = 'http',
): ExecutionContext {
  return {
    getType: () => type,
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => response,
    }),
  } as unknown as ExecutionContext;
}

const nextHandler: CallHandler = { handle: () => of('ok') };

describe('RequestIpInterceptor', () => {
  let interceptor: RequestIpInterceptor;
  let metrics: MetricsService;

  beforeEach(() => {
    metrics = new MetricsService({ enabled: true, path: '/metrics' });
    interceptor = new RequestIpInterceptor(metrics);
  });

  it('should be defined', () => {
    expect(interceptor).toBeDefined();
  });

  function resolveClientIp(request: any): string {
    interceptor.intercept(buildContext(request), nextHandler);
    return request.clientIp;
  }

  it('usa x-forwarded-for (primer valor) cuando está presente', () => {
    const request = {
      headers: { 'x-forwarded-for': '203.0.113.1, 70.41.3.18' },
    };
    expect(resolveClientIp(request)).toBe('203.0.113.1');
  });

  it('usa x-client-ip si no hay x-forwarded-for', () => {
    const request = { headers: { 'x-client-ip': '203.0.113.5' } };
    expect(resolveClientIp(request)).toBe('203.0.113.5');
  });

  it('usa cf-connecting-ip si no hay los headers anteriores', () => {
    const request = { headers: { 'cf-connecting-ip': '203.0.113.9' } };
    expect(resolveClientIp(request)).toBe('203.0.113.9');
  });

  it('usa request.ip cuando no hay headers de proxy', () => {
    const request = { headers: {}, ip: '127.0.0.1' };
    expect(resolveClientIp(request)).toBe('127.0.0.1');
  });

  it('usa request.connection.remoteAddress cuando está disponible', () => {
    const request = {
      headers: {},
      ip: undefined,
      connection: { remoteAddress: '10.0.0.9' },
    };
    expect(resolveClientIp(request)).toBe('10.0.0.9');
  });

  it('bug corregido: no lanza si request.connection es undefined, cae a request.socket.remoteAddress', () => {
    const request: any = {
      headers: {},
      ip: undefined,
      connection: undefined,
      socket: { remoteAddress: '10.0.0.5' },
    };
    expect(() => resolveClientIp(request)).not.toThrow();
    expect(request.clientIp).toBe('10.0.0.5');
  });

  it('bug corregido: no lanza si request.socket también es undefined, cae a request.connection.socket.remoteAddress', () => {
    const request: any = {
      headers: {},
      ip: undefined,
      connection: { socket: { remoteAddress: '10.0.0.20' } },
      socket: undefined,
    };
    expect(() => resolveClientIp(request)).not.toThrow();
    expect(request.clientIp).toBe('10.0.0.20');
  });

  it('retorna UNKNOWN sin lanzar cuando ninguna fuente de IP está disponible', () => {
    const request: any = {
      headers: {},
      ip: undefined,
      connection: undefined,
      socket: undefined,
    };
    expect(() => resolveClientIp(request)).not.toThrow();
    expect(request.clientIp).toBe('UNKNOWN');
  });

  it('deja pasar la petición hacia el siguiente handler', () => {
    const request = { headers: {}, ip: '127.0.0.1' };
    const result$ = interceptor.intercept(buildContext(request), nextHandler);
    expect(result$).toBeDefined();
  });

  describe('métricas HTTP', () => {
    const ROUTE_LABELS = 'route="/api/v1/documents/:id"';
    const IN_FLIGHT = `http_server_in_flight_requests{method="GET",${ROUTE_LABELS}}`;

    const buildRequest = (overrides: Record<string, unknown> = {}) => ({
      headers: { 'x-forwarded-for': '203.0.113.1' },
      method: 'GET',
      originalUrl: '/api/v1/documents/abc-123?token=secreto',
      route: { path: '/api/v1/documents/:id' },
      ...overrides,
    });

    const requestsSeries = (statusCode: number) =>
      `http_server_requests_total{method="GET",${ROUTE_LABELS},status_code="${statusCode}"}`;
    const durationSeries = (statusCode: number) =>
      `http_server_request_duration_seconds_count{method="GET",${ROUTE_LABELS},status_code="${statusCode}"}`;

    it('en el mismo flujo asigna la IP y registra contador, latencia y gauge', async () => {
      const request: any = buildRequest();

      const result = await lastValueFrom(
        interceptor.intercept(buildContext(request), {
          handle: () => of({ id: 1 }),
        }),
      );

      expect(result).toEqual({ id: 1 });
      expect(request.clientIp).toBe('203.0.113.1');
      const body = await metrics.getMetrics();
      expect(body).toContain(`${requestsSeries(200)} 1`);
      expect(body).toContain(`${durationSeries(200)} 1`);
      expect(body).toContain(`${IN_FLIGHT} 0`);
    });

    it('usa el statusCode de la respuesta', async () => {
      await lastValueFrom(
        interceptor.intercept(
          buildContext(buildRequest(), { statusCode: 201 }),
          nextHandler,
        ),
      );

      expect(await metrics.getMetrics()).toContain(`${requestsSeries(201)} 1`);
    });

    it('el gauge sube mientras la petición está en curso y vuelve a su valor al terminar', async () => {
      const handler$ = new Subject<string>();

      const finished = lastValueFrom(
        interceptor.intercept(buildContext(buildRequest()), {
          handle: () => handler$,
        }),
      );
      expect(await metrics.getMetrics()).toContain(`${IN_FLIGHT} 1`);

      handler$.next('ok');
      handler$.complete();
      await finished;
      expect(await metrics.getMetrics()).toContain(`${IN_FLIGHT} 0`);
    });

    it('no toca el gauge si nadie se suscribe al flujo', async () => {
      interceptor.intercept(buildContext(buildRequest()), nextHandler);

      expect(await metrics.getMetrics()).not.toContain(IN_FLIGHT);
    });

    it('un error HTTP se registra con su código y se propaga sin modificar', async () => {
      const exception = new NotFoundException('doc de ana@correo.mx');

      await expect(
        lastValueFrom(
          interceptor.intercept(buildContext(buildRequest()), {
            handle: () => throwError(() => exception),
          }),
        ),
      ).rejects.toBe(exception);

      const body = await metrics.getMetrics();
      expect(body).toContain(`${requestsSeries(404)} 1`);
      expect(body).toContain(`${durationSeries(404)} 1`);
      expect(body).toContain(
        `http_server_errors_total{${ROUTE_LABELS},status_code="404",error_type="NotFoundException"} 1`,
      );
      expect(body).toContain(`${IN_FLIGHT} 0`);
      expect(body).not.toContain('ana@correo.mx');
    });

    it('un error HTTP usa el código de la excepción aunque la respuesta aún diga 200', async () => {
      await expect(
        lastValueFrom(
          interceptor.intercept(
            buildContext(buildRequest(), { statusCode: 200 }),
            { handle: () => throwError(() => new BadRequestException()) },
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);

      const body = await metrics.getMetrics();
      expect(body).toContain(`${requestsSeries(400)} 1`);
      expect(body).not.toContain(`${requestsSeries(200)} 1`);
    });

    it('un error no controlado se registra como 500 y se propaga sin modificar', async () => {
      const exception = new Error('fallo con datos sensibles');

      await expect(
        lastValueFrom(
          interceptor.intercept(buildContext(buildRequest()), {
            handle: () => throwError(() => exception),
          }),
        ),
      ).rejects.toBe(exception);

      const body = await metrics.getMetrics();
      expect(body).toContain(`${requestsSeries(500)} 1`);
      expect(body).toContain(`${durationSeries(500)} 1`);
      expect(body).toContain(`${IN_FLIGHT} 0`);
      expect(body).not.toContain('datos sensibles');
    });

    it('si corre dos veces en la misma petición sólo mide una, y asigna la IP las dos', async () => {
      const request: any = buildRequest();
      const context = buildContext(request);

      await lastValueFrom(
        interceptor.intercept(context, {
          handle: () => interceptor.intercept(context, nextHandler),
        }),
      );

      const body = await metrics.getMetrics();
      expect(body).toContain(`${requestsSeries(200)} 1`);
      expect(body).toContain(`${durationSeries(200)} 1`);
      expect(body).toContain(`${IN_FLIGHT} 0`);
      expect(request.clientIp).toBe('203.0.113.1');
    });

    it('nunca usa la URL real, la IP ni la query como label', async () => {
      await lastValueFrom(
        interceptor.intercept(buildContext(buildRequest()), nextHandler),
      );

      const body = await metrics.getMetrics();
      expect(body).not.toContain('abc-123');
      expect(body).not.toContain('secreto');
      expect(body).not.toContain('203.0.113.1');
    });

    it.each([
      ['/health', 'GET'],
      ['/metrics', 'GET'],
      ['/api/v1/docs', 'GET'],
      ['/api/v1/integration/docs-json', 'GET'],
      ['/api/v1/documents/:id', 'OPTIONS'],
    ])(
      'excluye %s con %s, sin dejar de asignar la IP',
      async (path, method) => {
        const request: any = buildRequest({ method, route: { path } });

        await lastValueFrom(
          interceptor.intercept(buildContext(request), nextHandler),
        );

        expect(request.clientIp).toBe('203.0.113.1');
        const body = await metrics.getMetrics();
        expect(body).not.toContain('http_server_requests_total{');
        expect(body).not.toContain('http_server_in_flight_requests{');
      },
    );

    it('ignora los contextos que no son HTTP', async () => {
      const handled = jest.fn(() => of('ok'));
      const rpcPayload: any = {};

      await lastValueFrom(
        interceptor.intercept(buildContext(rpcPayload, undefined, 'rpc'), {
          handle: handled,
        }),
      );

      expect(handled).toHaveBeenCalledTimes(1);
      expect(rpcPayload.clientIp).toBeUndefined();
      expect(await metrics.getMetrics()).not.toContain(
        'http_server_requests_total{',
      );
    });

    it('con las métricas apagadas asigna la IP y no mide', async () => {
      const disabled = new MetricsService({ enabled: false, path: '/metrics' });
      const request: any = buildRequest();

      await lastValueFrom(
        new RequestIpInterceptor(disabled).intercept(
          buildContext(request),
          nextHandler,
        ),
      );

      expect(request.clientIp).toBe('203.0.113.1');
      expect(await disabled.getMetrics()).not.toContain(
        'http_server_requests_total{',
      );
    });
  });
});
