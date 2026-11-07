import { Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

import {
  getHttpErrorType,
  isHttpRequestClaimed,
  resolveRouteLabel,
} from '../http-metrics.utils';
import {
  CLIENT_CLOSED_REQUEST_ERROR_TYPE,
  CLIENT_CLOSED_REQUEST_STATUS,
} from '../metrics.constants';
import { MetricsService } from '../metrics.service';

/**
 * Mide las peticiones que nunca llegan a `RequestIpInterceptor`, que mide todas las demás.
 *
 * Los interceptores corren DESPUÉS de los guards: un 401 de `JwtAuthGuard`, un 429 o un 404 de una
 * ruta inexistente no pasan por ninguno y el tráfico rechazado no contaría. Un filtro tampoco
 * alcanza: sólo corre uno por excepción, y los de controlador (`IntegrationErrorFilter`) y
 * `MulterExceptionFilter` van antes. Mirar la respuesta al cerrarse ve el estado de esos caminos.
 */
@Injectable()
export class HttpMetricsMiddleware implements NestMiddleware {
  /** Con prefijo global, Nest monta el comodín en varias rutas y una petición puede caer en dos. */
  private readonly trackedRequests = new WeakSet<Request>();

  constructor(private readonly metrics: MetricsService) {}

  /**
   * Arranca el cronómetro y, al cerrarse la respuesta, registra la petición si ningún interceptor
   * la midió.
   *
   * La ruta se resuelve al cerrar porque aquí todavía no se conoce. Si el cliente cortó antes de
   * recibir la respuesta se registra como 499: `statusCode` diría 200 sin haberse enviado nada.
   *
   * @param request - Petición entrante.
   * @param response - Respuesta en curso.
   * @param next - Continúa con la cadena de Express.
   * @returns Nada.
   *
   * @example
   * ```ts
   * consumer.apply(HttpMetricsMiddleware).forRoutes('*');
   * ```
   */
  use(request: Request, response: Response, next: NextFunction): void {
    if (this.trackedRequests.has(request)) {
      next();
      return;
    }
    this.trackedRequests.add(request);

    const startedAt = process.hrtime.bigint();

    response.once('close', () => {
      if (isHttpRequestClaimed(request)) return;

      const finished = response.writableFinished;

      this.metrics.recordHttpRequest({
        method: request.method,
        route: resolveRouteLabel(request),
        statusCode: finished
          ? response.statusCode
          : CLIENT_CLOSED_REQUEST_STATUS,
        durationSeconds: Number(process.hrtime.bigint() - startedAt) / 1e9,
        errorType: finished
          ? getHttpErrorType(request)
          : CLIENT_CLOSED_REQUEST_ERROR_TYPE,
      });
    });

    next();
  }
}
