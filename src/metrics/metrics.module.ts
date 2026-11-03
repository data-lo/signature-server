import {
  DynamicModule,
  Inject,
  MiddlewareConsumer,
  Module,
  NestModule,
} from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER, RouterModule } from '@nestjs/core';

import { MetricsExceptionFilter } from './filters/metrics-exception.filter';
import {
  METRICS_OPTIONS,
  MetricsOptions,
  resolveMetricsOptions,
} from './metrics.constants';
import { MetricsController } from './metrics.controller';
import { MetricsService } from './metrics.service';
import { HttpMetricsMiddleware } from './middleware/http-metrics.middleware';

/**
 * Instrumentación de Prometheus. Es global para que los módulos de negocio inyecten
 * `MetricsService` sin importarlo, y `MetricsService` existe aunque esté apagado: así crear una
 * métrica de negocio no obliga a condicionar el código al valor de `METRICS_ENABLED`.
 */
@Module({})
export class MetricsModule implements NestModule {
  constructor(
    @Inject(METRICS_OPTIONS) private readonly options: MetricsOptions,
  ) {}

  /**
   * Monta el módulo con la configuración de las variables de entorno.
   *
   * `ConfigModule.forRoot` es asíncrono y carga el `.env`; hay que esperarlo porque la decisión de
   * montar el endpoint y su ruta se toman aquí, al declarar el módulo, y no al inyectar.
   *
   * @returns El módulo configurado.
   *
   * @throws {Error} Si `METRICS_PATH` no es válido.
   *
   * @example
   * ```ts
   * @Module({ imports: [MetricsModule.forRoot()] })
   * export class AppModule {}
   * ```
   */
  static async forRoot(): Promise<DynamicModule> {
    await ConfigModule.envVariablesLoaded;
    return MetricsModule.register(resolveMetricsOptions());
  }

  /**
   * Monta el módulo con opciones explícitas. Apagado, sólo deja disponible `MetricsService`, que
   * entonces no mide nada: ni endpoint, ni filtro, ni middleware.
   *
   * @param options - Si está activo y en qué ruta se expone.
   * @returns El módulo configurado.
   *
   * @example
   * ```ts
   * MetricsModule.register({ enabled: true, path: '/metrics' });
   * ```
   */
  static register(options: MetricsOptions): DynamicModule {
    const baseProviders = [
      { provide: METRICS_OPTIONS, useValue: options },
      MetricsService,
    ];

    return {
      module: MetricsModule,
      global: true,
      exports: [MetricsService],
      providers: options.enabled
        ? [
            ...baseProviders,
            { provide: APP_FILTER, useClass: MetricsExceptionFilter },
          ]
        : baseProviders,
      controllers: options.enabled ? [MetricsController] : [],
      imports: options.enabled
        ? [
            RouterModule.register([
              { path: options.path, module: MetricsModule },
            ]),
          ]
        : [],
    };
  }

  /**
   * Instala la medición sobre todas las rutas si el módulo está activo.
   *
   * @param consumer - Consumidor de middleware de Nest.
   * @returns Nada.
   *
   * @example
   * ```ts
   * // Lo invoca Nest al inicializar el módulo.
   * ```
   */
  configure(consumer: MiddlewareConsumer): void {
    if (this.options.enabled) {
      consumer.apply(HttpMetricsMiddleware).forRoutes('*');
    }
  }
}
