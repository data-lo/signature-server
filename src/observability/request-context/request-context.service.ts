import { Injectable } from '@nestjs/common';
import { AsyncLocalStorage } from 'async_hooks';

import { RequestContext } from './request-context.interface';

/**
 * Almacén único del proceso. Vive fuera de la clase para que toda instancia de
 * `RequestContextService` —la del contenedor de Nest, la que arma `applyRequestContext` o una de
 * prueba— lea y escriba el mismo contexto.
 */
const storage = new AsyncLocalStorage<RequestContext>();

/**
 * Lectura del contexto de la petición HTTP en curso (`RequestContext`), basado en
 * `AsyncLocalStorage`.
 *
 * El contexto lo abre `RequestContextMiddleware` al recibir la petición y se propaga solo por la
 * cadena asíncrona: no hace falta pasar el `Request` a los servicios. Fuera de una petición HTTP
 * —un consumidor de Kafka, un cron, el arranque— no hay contexto y las lecturas devuelven
 * `undefined`.
 */
@Injectable()
export class RequestContextService {
  /**
   * Ejecuta `callback` con `context` como contexto activo. Todo lo que `callback` dispare, síncrono
   * o asíncrono, ve ese contexto; al terminar, el contexto anterior sigue intacto.
   *
   * @param context - Contexto de la petición.
   * @param callback - Código a ejecutar dentro del contexto.
   * @returns Lo que devuelva `callback`.
   *
   * @example
   * ```ts
   * requestContext.run(context, () => next());
   * ```
   */
  run<T>(context: RequestContext, callback: () => T): T {
    return storage.run(context, callback);
  }

  /**
   * El contexto de la petición en curso.
   *
   * @returns El contexto, o `undefined` fuera de una petición HTTP.
   *
   * @example
   * ```ts
   * const context = requestContext.get();
   * context?.method; // 'POST'
   * ```
   */
  get(): RequestContext | undefined {
    return storage.getStore();
  }

  /**
   * El identificador de correlación de la petición en curso.
   *
   * @returns El `X-Request-Id` de la petición, o `undefined` fuera de una petición HTTP.
   *
   * @example
   * ```ts
   * this.logger.warn(`Reintento agotado (requestId=${requestContext.getRequestId()})`);
   * ```
   */
  getRequestId(): string | undefined {
    return storage.getStore()?.requestId;
  }
}
