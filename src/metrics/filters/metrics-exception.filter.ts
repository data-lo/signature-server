import { ArgumentsHost, Catch } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';

import { setHttpErrorType } from '../http-metrics.utils';

/**
 * Anota el tipo de la excepción para `http_server_errors_total` sin alterar la respuesta ni el log:
 * el manejo sigue siendo el de `BaseExceptionFilter`, el mismo que usa Nest cuando no hay filtro.
 *
 * Sus huecos los cubre otro: el interceptor anota lo que se lanza dentro del handler, y
 * `MulterExceptionFilter` —que en `main.ts` tiene precedencia— las `HttpException` de los guards.
 */
@Catch()
export class MetricsExceptionFilter extends BaseExceptionFilter {
  /**
   * Anota la excepción y delega la respuesta en el manejo por defecto de Nest.
   *
   * @param exception - Lo que se lanzó al atender la petición.
   * @param host - Contexto de la petición.
   * @returns Nada; `BaseExceptionFilter` escribe la respuesta.
   *
   * @example
   * ```ts
   * { provide: APP_FILTER, useClass: MetricsExceptionFilter }
   * ```
   */
  catch(exception: unknown, host: ArgumentsHost): void {
    setHttpErrorType(host.switchToHttp().getRequest<object>(), exception);
    super.catch(exception, host);
  }
}
