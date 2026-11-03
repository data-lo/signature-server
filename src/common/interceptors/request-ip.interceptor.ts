import {
  CallHandler,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import type { Response } from 'express';
import { catchError, defer, finalize, Observable, tap, throwError } from 'rxjs';

import {
  claimHttpRequest,
  getHttpErrorType,
  resolveRouteLabel,
  setHttpErrorType,
} from 'src/metrics/http-metrics.utils';
import { MetricsService } from 'src/metrics/metrics.service';

@Injectable()
export class RequestIpInterceptor implements NestInterceptor {
  constructor(private readonly metrics: MetricsService) {}

  /**
   * Deja la IP del cliente en `request.clientIp` y mide la petición.
   *
   * Los contextos que no son HTTP (Kafka) pasan de largo: no tienen IP ni métricas HTTP.
   *
   * @param context - Contexto de ejecución.
   * @param next - Handler de la ruta.
   * @returns El flujo del handler, con sus valores y sus errores sin modificar.
   *
   * @example
   * ```ts
   * { provide: APP_INTERCEPTOR, useClass: RequestIpInterceptor }
   * ```
   */
  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    if (context.getType() !== 'http') {
      return next.handle();
    }

    const http = context.switchToHttp();
    const request = http.getRequest();
    const ip = this.getClientIp(request);
    request.clientIp = ip;

    return this.measure(request, http.getResponse<Response>(), next);
  }

  /**
   * Registra el gauge, el contador y la duración de la petición.
   *
   * Todo va dentro de `defer` para que el gauge sólo suba si alguien se suscribe: `finalize` no
   * correría sin suscripción y la petición quedaría «en curso» para siempre.
   *
   * Este interceptor es global y además se declara con `@UseInterceptors` en varias rutas, así que
   * puede correr dos veces por petición: sólo mide la primera (`claimHttpRequest`).
   *
   * El estado de un error sale de la excepción, antes de los filtros. Un filtro que lo traduzca
   * (400 → 422 en `ApiKeyValidationFilter` e `IntegrationErrorFilter`) responde otro código que el
   * que queda en la métrica.
   *
   * @param request - Petición en curso.
   * @param response - Respuesta en curso.
   * @param next - Handler de la ruta.
   * @returns El flujo del handler, con sus valores y sus errores sin modificar.
   *
   * @example
   * ```ts
   * return this.measure(request, response, next);
   * ```
   */
  private measure(
    request: any,
    response: Response,
    next: CallHandler,
  ): Observable<any> {
    return defer(() => {
      const method: string = request.method;
      const route = resolveRouteLabel(request);

      if (
        !this.metrics.shouldMeasure(method, route) ||
        !claimHttpRequest(request)
      ) {
        return next.handle();
      }

      const release = this.metrics.trackInFlightRequest(method, route);
      const startedAt = performance.now();
      const record = (statusCode: number, errorType?: string) =>
        this.metrics.recordHttpRequest({
          method,
          route,
          statusCode,
          durationSeconds: (performance.now() - startedAt) / 1000,
          errorType,
        });

      return next.handle().pipe(
        tap({ complete: () => record(response.statusCode) }),
        catchError((exception: unknown) => {
          setHttpErrorType(request, exception);
          record(
            exception instanceof HttpException
              ? exception.getStatus()
              : HttpStatus.INTERNAL_SERVER_ERROR,
            getHttpErrorType(request),
          );
          return throwError(() => exception);
        }),
        finalize(release),
      );
    });
  }

  private getClientIp(request: any): string {
    if (request.headers['x-forwarded-for']) {
      return request.headers['x-forwarded-for'].split(',')[0].trim();
    }
    if (request.headers['x-client-ip']) {
      return request.headers['x-client-ip'];
    }
    if (request.headers['cf-connecting-ip']) {
      return request.headers['cf-connecting-ip'];
    }
    // Bug corregido: `request.connection` es un alias legacy de `request.socket` que Node/Express
    // no siempre expone (según versión/transporte) — accederlo sin optional chaining lanzaba
    // "Cannot read properties of undefined (reading 'remoteAddress')" y tumbaba la petición
    // completa en vez de caer a los siguientes fallbacks.
    return (
      request.ip ||
      request.connection?.remoteAddress ||
      request.socket?.remoteAddress ||
      request.connection?.socket?.remoteAddress ||
      'UNKNOWN'
    );
  }
}
