import { Controller, Get, Res } from '@nestjs/common';
import type { Response } from 'express';

import { SkipJwtAuth } from 'src/auth/decorators/skip-jwt-auth.decorator';

import { MetricsService } from './metrics.service';

/**
 * Endpoint de consulta de Prometheus. Su ruta sale de `METRICS_PATH` y se monta en
 * `MetricsModule.register`, por eso `@Controller()` no declara ninguna.
 */
@Controller()
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  /**
   * Devuelve las métricas en el formato de exposición de Prometheus.
   *
   * Sin credenciales, igual que `/health`: Prometheus consulta sin JWT ni `x-api-key`. No devuelve
   * datos de negocio, pero sí revela rutas y volumen de tráfico, así que la protección es de red:
   * el proxy público tiene que bloquear esta ruta (ver README, «Métricas de Prometheus»).
   *
   * @param response - Respuesta HTTP, para fijar el `Content-Type`.
   * @returns El texto de exposición.
   *
   * @example
   * ```ts
   * // curl http://localhost:3000/metrics
   * ```
   */
  @Get()
  @SkipJwtAuth()
  getMetrics(@Res({ passthrough: true }) response: Response): Promise<string> {
    response.setHeader('Content-Type', this.metrics.getContentType());
    return this.metrics.getMetrics();
  }
}
