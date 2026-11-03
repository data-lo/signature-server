import { CallHandler, ExecutionContext } from '@nestjs/common';
import { EventEmitter } from 'events';
import { lastValueFrom, of, throwError } from 'rxjs';

import { getHttpErrorType } from '../http-metrics.utils';
import { MetricsService } from '../metrics.service';
import { HttpMetricsInterceptor } from './http-metrics.interceptor';

const IN_FLIGHT_SERIES =
  'http_server_in_flight_requests{method="GET",route="/x/:id"}';

describe('HttpMetricsInterceptor', () => {
  let metrics: MetricsService;
  let interceptor: HttpMetricsInterceptor;
  let request: { method: string; route: { path: string } };
  let response: EventEmitter;
  let context: ExecutionContext;

  beforeEach(() => {
    metrics = new MetricsService({ enabled: false, path: '/metrics' });
    interceptor = new HttpMetricsInterceptor(metrics);
    request = { method: 'GET', route: { path: '/x/:id' } };
    response = new EventEmitter();
    context = {
      switchToHttp: () => ({
        getRequest: () => request,
        getResponse: () => response,
      }),
    } as unknown as ExecutionContext;
  });

  it('la petición cuenta como en curso hasta que se cierra la respuesta, no hasta que acaba el handler', async () => {
    const next: CallHandler = { handle: () => of('ok') };

    await lastValueFrom(interceptor.intercept(context, next));
    expect(await metrics.getMetrics()).toContain(`${IN_FLIGHT_SERIES} 1`);

    response.emit('close');
    expect(await metrics.getMetrics()).toContain(`${IN_FLIGHT_SERIES} 0`);
  });

  it('no altera el valor que devuelve el handler ni anota error', async () => {
    const next: CallHandler = { handle: () => of({ id: 1 }) };

    await expect(
      lastValueFrom(interceptor.intercept(context, next)),
    ).resolves.toEqual({ id: 1 });
    expect(getHttpErrorType(request)).toBeUndefined();
  });

  it('anota la clase de la excepción y la deja seguir hacia los filtros', async () => {
    class SigningFailedException extends Error {}
    const exception = new SigningFailedException('dato sensible');
    const next: CallHandler = { handle: () => throwError(() => exception) };

    await expect(
      lastValueFrom(interceptor.intercept(context, next)),
    ).rejects.toBe(exception);
    expect(getHttpErrorType(request)).toBe('SigningFailedException');
  });
});
