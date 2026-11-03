import { Inject, Injectable } from '@nestjs/common';
import {
  collectDefaultMetrics,
  Counter,
  CounterConfiguration,
  Gauge,
  GaugeConfiguration,
  Histogram,
  HistogramConfiguration,
  Registry,
} from '@prometheus-io/client';

import {
  FORBIDDEN_METRIC_LABELS,
  HEALTH_ROUTE,
  HTTP_ERRORS_TOTAL_METRIC,
  HTTP_IN_FLIGHT_REQUESTS_METRIC,
  HTTP_REQUEST_DURATION_BUCKETS,
  HTTP_REQUEST_DURATION_METRIC,
  HTTP_REQUESTS_TOTAL_METRIC,
  METRICS_OPTIONS,
  MetricsOptions,
  UNKNOWN_ERROR_TYPE,
} from './metrics.constants';

/** Resultado de una petición HTTP ya atendida. */
export interface HttpRequestSample {
  method: string;
  route: string;
  statusCode: number;
  durationSeconds: number;
  /** Clase de la excepción; sólo se usa cuando `statusCode` es 4xx o 5xx. */
  errorType?: string;
}

/**
 * Dueño del registro de Prometheus de la aplicación: declara las métricas HTTP y las de runtime de
 * Node, y es el único punto donde se crean métricas nuevas.
 *
 * Usa un `Registry` propio y no el global del cliente para que cada instancia de la aplicación
 * (hay varias en una corrida de pruebas) tenga el suyo: repetir el nombre de una métrica en un
 * mismo registro lanza excepción.
 */
@Injectable()
export class MetricsService {
  private readonly registry = new Registry();
  private readonly ignoredRoutes: ReadonlySet<string>;

  private readonly httpRequestsTotal: Counter<
    'method' | 'route' | 'status_code'
  >;
  private readonly httpRequestDuration: Histogram<
    'method' | 'route' | 'status_code'
  >;
  private readonly httpInFlightRequests: Gauge<'method' | 'route'>;
  private readonly httpErrorsTotal: Counter<
    'route' | 'status_code' | 'error_type'
  >;

  constructor(@Inject(METRICS_OPTIONS) options: MetricsOptions) {
    this.ignoredRoutes = new Set([HEALTH_ROUTE, options.path]);

    if (options.enabled) {
      collectDefaultMetrics({ register: this.registry });
    }

    this.httpRequestsTotal = this.createCounter({
      name: HTTP_REQUESTS_TOTAL_METRIC,
      help: 'Peticiones HTTP finalizadas.',
      labelNames: ['method', 'route', 'status_code'],
    });
    this.httpRequestDuration = this.createHistogram({
      name: HTTP_REQUEST_DURATION_METRIC,
      help: 'Duración de las peticiones HTTP, en segundos.',
      labelNames: ['method', 'route', 'status_code'],
      buckets: HTTP_REQUEST_DURATION_BUCKETS,
    });
    this.httpInFlightRequests = this.createGauge({
      name: HTTP_IN_FLIGHT_REQUESTS_METRIC,
      help: 'Peticiones HTTP en curso que ya pasaron los guards.',
      labelNames: ['method', 'route'],
    });
    this.httpErrorsTotal = this.createCounter({
      name: HTTP_ERRORS_TOTAL_METRIC,
      help: 'Peticiones HTTP finalizadas con estado 4xx o 5xx.',
      labelNames: ['route', 'status_code', 'error_type'],
    });
  }

  /**
   * Crea un contador en el registro de la aplicación.
   *
   * @param configuration - Nombre, ayuda y labels de la métrica.
   * @returns El contador.
   *
   * @throws {Error} Si usa un label prohibido o el nombre ya está registrado.
   *
   * @example
   * ```ts
   * const signed = metrics.createCounter({
   *   name: 'documents_signed_total',
   *   help: 'Documentos firmados.',
   *   labelNames: ['signature_type'],
   * });
   * ```
   */
  createCounter<T extends string>(
    configuration: Omit<CounterConfiguration<T>, 'registers'>,
  ): Counter<T> {
    this.assertAllowedLabels(configuration.labelNames);
    return new Counter({ ...configuration, registers: [this.registry] });
  }

  /**
   * Crea un gauge en el registro de la aplicación.
   *
   * @param configuration - Nombre, ayuda y labels de la métrica.
   * @returns El gauge.
   *
   * @throws {Error} Si usa un label prohibido o el nombre ya está registrado.
   *
   * @example
   * ```ts
   * const pending = metrics.createGauge({
   *   name: 'webhook_deliveries_pending',
   *   help: 'Entregas de webhook pendientes.',
   * });
   * ```
   */
  createGauge<T extends string>(
    configuration: Omit<GaugeConfiguration<T>, 'registers'>,
  ): Gauge<T> {
    this.assertAllowedLabels(configuration.labelNames);
    return new Gauge({ ...configuration, registers: [this.registry] });
  }

  /**
   * Crea un histograma en el registro de la aplicación.
   *
   * @param configuration - Nombre, ayuda, labels y cubetas de la métrica.
   * @returns El histograma.
   *
   * @throws {Error} Si usa un label prohibido o el nombre ya está registrado.
   *
   * @example
   * ```ts
   * const sealing = metrics.createHistogram({
   *   name: 'document_seal_duration_seconds',
   *   help: 'Duración del sellado.',
   *   buckets: [1, 5, 15, 30, 60],
   * });
   * ```
   */
  createHistogram<T extends string>(
    configuration: Omit<HistogramConfiguration<T>, 'registers'>,
  ): Histogram<T> {
    this.assertAllowedLabels(configuration.labelNames);
    return new Histogram({ ...configuration, registers: [this.registry] });
  }

  /**
   * Registra una petición finalizada: contador, histograma y, si es 4xx o 5xx, contador de errores.
   *
   * `/health` y el propio endpoint de métricas se descartan: son sondeos periódicos de
   * infraestructura y aplanarían la latencia y el volumen reales de la API.
   *
   * @param sample - Resultado de la petición.
   * @returns Nada.
   *
   * @example
   * ```ts
   * metrics.recordHttpRequest({
   *   method: 'GET',
   *   route: '/api/v1/document/:id',
   *   statusCode: 404,
   *   durationSeconds: 0.012,
   *   errorType: 'NotFoundException',
   * });
   * ```
   */
  recordHttpRequest(sample: HttpRequestSample): void {
    if (this.ignoredRoutes.has(sample.route)) return;

    const labels = {
      method: sample.method,
      route: sample.route,
      status_code: sample.statusCode,
    };
    this.httpRequestsTotal.inc(labels);
    this.httpRequestDuration.observe(labels, sample.durationSeconds);

    if (sample.statusCode >= 400) {
      this.httpErrorsTotal.inc({
        route: sample.route,
        status_code: sample.statusCode,
        error_type: sample.errorType ?? UNKNOWN_ERROR_TYPE,
      });
    }
  }

  /**
   * Suma una petición al gauge de peticiones en curso.
   *
   * @param method - Método HTTP.
   * @param route - Plantilla de la ruta.
   * @returns La función que la descuenta al terminar; no hace nada si la ruta no se mide.
   *
   * @example
   * ```ts
   * const release = metrics.trackInFlightRequest('GET', '/api/v1/document/:id');
   * response.once('close', release);
   * ```
   */
  trackInFlightRequest(method: string, route: string): () => void {
    if (this.ignoredRoutes.has(route)) return () => undefined;

    const labels = { method, route };
    this.httpInFlightRequests.inc(labels);
    return () => this.httpInFlightRequests.dec(labels);
  }

  /**
   * Serializa el registro en el formato de exposición.
   *
   * @returns El texto que consume Prometheus.
   *
   * @example
   * ```ts
   * const body = await metrics.getMetrics();
   * ```
   */
  getMetrics(): Promise<string> {
    return this.registry.metrics();
  }

  /**
   * Devuelve el `Content-Type` del formato de exposición del registro.
   *
   * @returns El valor del header.
   *
   * @example
   * ```ts
   * metrics.getContentType(); // 'text/plain; version=0.0.4; charset=utf-8'
   * ```
   */
  getContentType(): string {
    return this.registry.contentType;
  }

  /**
   * Rechaza los labels con datos personales o de cardinalidad sin límite.
   *
   * @param labelNames - Labels de la métrica que se está creando.
   * @returns Nada.
   *
   * @throws {Error} Si alguno está en `FORBIDDEN_METRIC_LABELS`.
   *
   * @example
   * ```ts
   * this.assertAllowedLabels(['user_id']); // lanza
   * ```
   */
  private assertAllowedLabels(labelNames: readonly string[] = []): void {
    const forbidden = labelNames.filter((label) =>
      FORBIDDEN_METRIC_LABELS.includes(label.toLowerCase()),
    );

    if (forbidden.length > 0) {
      throw new Error(
        `Labels prohibidos en una métrica: ${forbidden.join(', ')}.`,
      );
    }
  }
}
