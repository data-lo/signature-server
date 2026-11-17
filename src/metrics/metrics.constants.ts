/** Token de inyección de las opciones resueltas del módulo de métricas. */
export const METRICS_OPTIONS = 'METRICS_OPTIONS';

/** Configuración del módulo de métricas. */
export interface MetricsOptions {
  /** Si es `false` no se expone el endpoint ni se instrumenta ninguna petición. */
  enabled: boolean;
  /** Ruta del endpoint, con diagonal inicial y sin diagonal final. */
  path: string;
}

export const DEFAULT_METRICS_PATH = '/metrics';

/** Ruta de los probes de infraestructura: no es tráfico de la API y no se mide. */
export const HEALTH_ROUTE = '/health';

export const HTTP_REQUESTS_TOTAL_METRIC = 'http_server_requests_total';
export const HTTP_REQUEST_DURATION_METRIC =
  'http_server_request_duration_seconds';
export const HTTP_IN_FLIGHT_REQUESTS_METRIC = 'http_server_in_flight_requests';
export const HTTP_ERRORS_TOTAL_METRIC = 'http_server_errors_total';

/**
 * Cubetas del histograma HTTP, en segundos. Llegan a 60 s porque sellar un documento o subir un
 * PDF de 20 MB tarda mucho más que una petición común; con las cubetas por defecto del cliente
 * (tope de 10 s) esas operaciones caerían todas en `+Inf`.
 */
export const HTTP_REQUEST_DURATION_BUCKETS = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60,
];

/**
 * Valor del label `route` para lo que no resolvió a un controlador. Va todo junto: usar la URL
 * real dejaría que cualquier escaneo creara series sin límite.
 */
export const UNMATCHED_ROUTE_LABEL = 'unmatched';

/** Estado con que se registra una petición cuyo cliente cortó antes de recibir la respuesta. */
export const CLIENT_CLOSED_REQUEST_STATUS = 499;
export const CLIENT_CLOSED_REQUEST_ERROR_TYPE = 'ClientClosedRequest';

/** `error_type` de un 4xx/5xx cuya excepción no se pudo observar (ver `http-metrics.utils.ts`). */
export const UNKNOWN_ERROR_TYPE = 'UnknownError';

/**
 * Labels prohibidos en cualquier métrica: datos personales o de cardinalidad sin límite.
 * `MetricsService` los rechaza al crear la métrica, también en las futuras de negocio.
 */
export const FORBIDDEN_METRIC_LABELS: readonly string[] = [
  'user_id',
  'organization_id',
  'account_id',
  'document_id',
  'email',
  'correo',
  'curp',
  'ip',
  'token',
  'message',
  'error_message',
];

const METRICS_PATH_PATTERN = /^\/[A-Za-z0-9._~/-]*$/;

/**
 * Resuelve las opciones del módulo a partir de las variables de entorno.
 *
 * `METRICS_ENABLED` se activa sólo con `true` explícito: un despliegue que todavía no tiene la
 * variable no debe empezar a publicar un endpoint sin credenciales.
 *
 * @param env - Variables de entorno; `process.env` por defecto.
 * @returns Las opciones con la ruta normalizada.
 *
 * @throws {Error} Si `METRICS_PATH` no es una ruta estática o choca con `/` o `/health`.
 *
 * @example
 * ```ts
 * resolveMetricsOptions({ METRICS_ENABLED: 'true', METRICS_PATH: 'internal/metrics/' });
 * // { enabled: true, path: '/internal/metrics' }
 * ```
 */
export function resolveMetricsOptions(
  env: NodeJS.ProcessEnv = process.env,
): MetricsOptions {
  const rawPath = env.METRICS_PATH?.trim() || DEFAULT_METRICS_PATH;
  const path = `/${rawPath.replace(/^\/+|\/+$/g, '')}`;

  if (
    !METRICS_PATH_PATTERN.test(path) ||
    path === '/' ||
    path === HEALTH_ROUTE
  ) {
    throw new Error(`METRICS_PATH inválido: "${rawPath}".`);
  }

  return { enabled: env.METRICS_ENABLED?.trim() === 'true', path };
}
