import { Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

import { getHttpErrorType, resolveRouteLabel } from '../http-metrics.utils';
import {
  CLIENT_CLOSED_REQUEST_ERROR_TYPE,
  CLIENT_CLOSED_REQUEST_STATUS,
} from '../metrics.constants';
import { MetricsService } from '../metrics.service';

/**
 * Mide cada petición de principio a fin: contador, histograma y contador de errores.
 *
 * Tiene que ser un middleware y no el interceptor porque los interceptores corren DESPUÉS de los
 * guards: un 401 de `JwtAuthGuard`, un 429 o un 404 de una ruta inexistente nunca llegarían a él y
 * el tráfico rechazado no contaría. Un filtro tampoco alcanza para contar: sólo corre uno por
 * excepción y los de controlador (`IntegrationErrorFilter`) y `MulterExceptionFilter` van antes.
 * Mirar la respuesta al cerrarse es lo único que ve el estado final de todos los caminos.
 */
@Injectable()
export class HttpMetricsMiddleware implements NestMiddleware {
  /** Con prefijo global, Nest monta el comodín en varias rutas y una petición puede caer en dos. */
  private readonly trackedRequests = new WeakSet<Request>();

  constructor(private readonly metrics: MetricsService) {}

  /**
   * Arranca el cronómetro y registra la petición cuando se cierra la respuesta.
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
