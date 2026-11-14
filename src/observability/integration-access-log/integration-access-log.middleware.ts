import { Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { isIP } from 'net';

import { GLOBAL_API_PREFIX } from 'src/common/constants/api-prefix.constants';
import {
  getHttpErrorType,
  resolveRouteLabel,
} from 'src/metrics/http-metrics.utils';

import { REQUEST_ID_HEADER } from '../request-context/request-context.constants';
import { RequestContextService } from '../request-context/request-context.service';
import { getIntegrationAccessAnnotations } from './integration-access-log.annotations';
import { buildIntegrationAccessLogEvent } from './integration-access-log.sanitizer';
import { IntegrationAccessLogger } from './integration-access.logger';

/** Prefijo de la API de integración, en minúsculas (Express no distingue mayúsculas al rutear). */
export const INTEGRATION_ACCESS_LOG_PREFIX = `/${GLOBAL_API_PREFIX}/integration`;

/**
 * Rutas bajo el prefijo que NO son la API: la documentación Swagger (`/integration/docs`,
 * `/integration/docs-json`, `/integration/docs-yaml` y sus estáticos). No llevan API key ni
 * operan sobre nada, y una visita a la página son media docena de peticiones de CSS y JS.
 */
const DOCS_PATH = /^\/api\/v1\/integration\/docs(?:[-/]|$)/;

/** Lo que el middleware necesita del `Request` además de lo de Express. */
type IntegrationRequest = Request & {
  apiClient?: { apiKeyId?: unknown; organizationId?: unknown };
  clientIp?: unknown;
};

/**
 * Escribe exactamente un evento `integration.http_request` por cada petición a
 * `/api/v1/integration/*`, al cerrarse la respuesta.
 *
 * Es middleware de Express y no interceptor porque tiene que ver también lo que nunca llega al
 * controller: el 401/403 de `OrganizationApiKeyGuard`, el 404 de una ruta inexistente, el 400 de
 * un JSON mal formado o una conexión que el cliente corta. Lo monta `applyIntegrationAccessLog`
 * en `main.ts`, justo después del contexto de petición, por lo que ya conoce el `requestId`.
 *
 * Lee, al cerrar, sólo datos ya resueltos por otras piezas —`request.apiClient` del guard,
 * `request.clientIp` de `RequestIpInterceptor`, `request.params.documentId` del router y lo
 * anotado con `annotateIntegrationAccess`— y nunca headers de autenticación, body, query ni
 * archivos. No toca métricas: sus labels siguen siendo las de `HttpMetricsMiddleware`.
 */
@Injectable()
export class IntegrationAccessLogMiddleware implements NestMiddleware {
  /** Una petición puede pasar dos veces si alguien vuelve a montar el middleware. */
  private readonly trackedRequests = new WeakSet<Request>();

  constructor(
    private readonly requestContext: RequestContextService,
    private readonly accessLogger: IntegrationAccessLogger,
  ) {}

  /**
   * Si la petición es de la API de integración, arranca el cronómetro y registra el evento al
   * cerrarse la respuesta.
   *
   * @param request - Petición entrante.
   * @param response - Respuesta en curso.
   * @param next - Continúa con la cadena de Express.
   * @returns Nada.
   *
   * @example
   * ```ts
   * app.use(middleware.use.bind(middleware));
   * ```
   */
  use(request: Request, response: Response, next: NextFunction): void {
    if (
      !isIntegrationApiPath(request.originalUrl ?? request.url) ||
      this.trackedRequests.has(request)
    ) {
      next();
      return;
    }
    this.trackedRequests.add(request);

    const startedAt = process.hrtime.bigint();
    // En el `close` ya no hay contexto asíncrono: se toma ahora, y el header es el respaldo.
    const requestId =
      this.requestContext.getRequestId() ??
      response.getHeader(REQUEST_ID_HEADER);

    response.once('close', () => {
      try {
        this.accessLogger.log(
          this.buildEvent(
            request as IntegrationRequest,
            response,
            requestId,
            startedAt,
          ),
        );
      } catch {
        // Un fallo al armar el log no debe tumbar el proceso desde un listener de `close`.
      }
    });

    next();
  }

  private buildEvent(
    request: IntegrationRequest,
    response: Response,
    requestId: unknown,
    startedAt: bigint,
  ) {
    const annotations = getIntegrationAccessAnnotations(request);
    return buildIntegrationAccessLogEvent({
      requestId,
      method: request.method,
      route: routeTemplateOf(request),
      statusCode: response.writableFinished ? response.statusCode : null,
      durationMs: Number(process.hrtime.bigint() - startedAt) / 1e6,
      apiKeyId: request.apiClient?.apiKeyId,
      organizationId: request.apiClient?.organizationId,
      documentId: annotations.documentId ?? request.params?.documentId,
      ip: resolveAccessLogIp(request),
      errorCode: annotations.errorCode,
      idempotencyReplayed: annotations.idempotencyReplayed,
      errorType: annotations.errorType ?? getHttpErrorType(request),
    });
  }
}

/**
 * Indica si una URL es de la API de integración, sin contar su documentación Swagger.
 *
 * @param url - `request.originalUrl`.
 * @returns `true` para `/api/v1/integration` y todo lo que cuelga de ella, salvo `/docs`.
 *
 * @example
 * ```ts
 * isIntegrationApiPath('/api/v1/integration/documents?page=2'); // true
 * isIntegrationApiPath('/api/v1/integration-settings'); // false
 * isIntegrationApiPath('/api/v1/integration/docs-json'); // false
 * ```
 */
export function isIntegrationApiPath(url: string): boolean {
  const path = url.split(/[?#]/, 1)[0].toLowerCase();
  const isUnderPrefix =
    path === INTEGRATION_ACCESS_LOG_PREFIX ||
    path.startsWith(`${INTEGRATION_ACCESS_LOG_PREFIX}/`);
  return isUnderPrefix && !DOCS_PATH.test(path);
}

/**
 * La plantilla de la ruta, con el prefijo global, o `unmatched` si ningún controller la resolvió.
 *
 * Según cómo Nest registre la ruta, `request.route.path` puede venir con o sin el prefijo; el log
 * lo publica siempre completo para que se pueda buscar tal como aparece en el contrato.
 *
 * @param request - Petición atendida.
 * @returns `/api/v1/integration/documents/:documentId/signing-access`, o `unmatched`.
 *
 * @example
 * ```ts
 * routeTemplateOf(request); // '/api/v1/integration/documents'
 * ```
 */
export function routeTemplateOf(request: Pick<Request, 'route'>): string {
  const route = resolveRouteLabel(request);
  if (!route.startsWith('/')) return route;
  return route.startsWith(`/${GLOBAL_API_PREFIX}/`)
    ? route
    : `/${GLOBAL_API_PREFIX}${route}`;
}

/**
 * IP del cliente para el log.
 *
 * Usa `request.clientIp` si `RequestIpInterceptor` llegó a resolverla y es una IP válida. En un
 * rechazo temprano (guard, ruta inexistente, body mal formado) el interceptor no corrió: entonces
 * se usa la dirección del socket que da Express (`request.ip`), sin leer headers que el cliente
 * controla. Detrás de un proxy, esa es la IP del proxy.
 *
 * @param request - Petición atendida.
 * @returns Una IP v4 o v6 válida, o `null`.
 *
 * @example
 * ```ts
 * resolveAccessLogIp({ clientIp: '203.0.113.7' }); // '203.0.113.7'
 * resolveAccessLogIp({ clientIp: 'UNKNOWN', ip: '::1' }); // '::1'
 * ```
 */
export function resolveAccessLogIp(
  request: Pick<IntegrationRequest, 'clientIp' | 'ip' | 'socket'>,
): string | null {
  for (const candidate of [
    request.clientIp,
    request.ip,
    request.socket?.remoteAddress,
  ]) {
    if (typeof candidate === 'string' && isIP(candidate)) return candidate;
  }
  return null;
}
