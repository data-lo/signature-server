import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { Observable, tap } from 'rxjs';

import { resolveRouteLabel, setHttpErrorType } from '../http-metrics.utils';
import { MetricsService } from '../metrics.service';

/**
 * Mide las peticiones en curso y anota la excepción de las que fallan al atenderse.
 *
 * El conteo y la duración viven en `HttpMetricsMiddleware` para incluir lo que rechazan los guards;
 * el gauge vive aquí porque su label `route` exige conocer la ruta al ENTRAR, y el middleware corre
 * antes de que Express la resuelva. Por eso una petición detenida en un guard no cuenta como en curso.
 */
@Injectable()
export class HttpMetricsInterceptor implements NestInterceptor {
  constructor(private readonly metrics: MetricsService) {}

  /**
   * Suma la petición al gauge hasta que se cierre la respuesta.
   *
   * Se descuenta en el `close` y no al terminar el observable para cubrir también las descargas por
   * streaming y las rutas con `@Res()`, cuyo handler termina antes que la respuesta. Aquí se anota
   * la excepción porque un filtro de controlador puede quedársela antes que el filtro global.
   *
   * @param context - Contexto de ejecución de la petición.
   * @param next - Handler de la ruta.
   * @returns El flujo del handler, sin modificarlo.
   *
   * @example
   * ```ts
   * { provide: APP_INTERCEPTOR, useClass: HttpMetricsInterceptor }
   * ```
   */
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();

    response.once(
      'close',
      this.metrics.trackInFlightRequest(
        request.method,
        resolveRouteLabel(request),
      ),
    );

    return next.handle().pipe(
      tap({
        error: (exception: unknown) => setHttpErrorType(request, exception),
      }),
    );
  }
}
