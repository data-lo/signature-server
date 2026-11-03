import { EventEmitter } from 'events';
import type { Request, Response } from 'express';

import { setHttpErrorType } from '../http-metrics.utils';
import { MetricsService } from '../metrics.service';
import { HttpMetricsMiddleware } from './http-metrics.middleware';

/** Respuesta mínima: sólo lo que lee el middleware. */
function buildResponse(statusCode: number, writableFinished: boolean) {
  return Object.assign(new EventEmitter(), {
    statusCode,
    writableFinished,
  }) as unknown as Response;
}

describe('HttpMetricsMiddleware', () => {
  let metrics: MetricsService;
  let middleware: HttpMetricsMiddleware;
  let record: jest.SpyInstance;

  beforeEach(() => {
    metrics = new MetricsService({ enabled: false, path: '/metrics' });
    middleware = new HttpMetricsMiddleware(metrics);
    record = jest.spyOn(metrics, 'recordHttpRequest');
  });

  it('continúa la cadena y no registra nada hasta que se cierra la respuesta', () => {
    const next = jest.fn();

    middleware.use(
      { method: 'GET' } as Request,
      buildResponse(200, true),
      next,
    );

    expect(next).toHaveBeenCalledTimes(1);
    expect(record).not.toHaveBeenCalled();
  });

  it('registra la ruta resuelta y el estado final de la respuesta', () => {
    const request = { method: 'GET' } as Request;
    const response = buildResponse(200, true);

    middleware.use(request, response, jest.fn());
    (request as { route: unknown }).route = { path: '/x/:id' };
    response.statusCode = 403;
    setHttpErrorType(request, new TypeError());
    response.emit('close');

    expect(record).toHaveBeenCalledWith({
      method: 'GET',
      route: '/x/:id',
      statusCode: 403,
      durationSeconds: expect.any(Number),
      errorType: 'TypeError',
    });
  });

  it('sin controlador que la resuelva, la ruta es "unmatched" y nunca la URL', () => {
    const request = { method: 'GET', url: '/wp-login.php' } as Request;
    const response = buildResponse(404, true);

    middleware.use(request, response, jest.fn());
    response.emit('close');

    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ route: 'unmatched', statusCode: 404 }),
    );
  });

  it('si el cliente corta antes de la respuesta se registra 499 y no el 200 por defecto', () => {
    const request = { method: 'POST' } as Request;
    const response = buildResponse(200, false);

    middleware.use(request, response, jest.fn());
    response.emit('close');

    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 499,
        errorType: 'ClientClosedRequest',
      }),
    );
  });

  it('una petición que cae en dos montajes del comodín se mide una sola vez', () => {
    const request = { method: 'GET' } as Request;
    const response = buildResponse(200, true);
    const next = jest.fn();

    middleware.use(request, response, next);
    middleware.use(request, response, next);
    response.emit('close');

    expect(next).toHaveBeenCalledTimes(2);
    expect(record).toHaveBeenCalledTimes(1);
  });
});
