import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { WebhookEventEntity } from 'src/webhooks/entities/webhook-event.entity';
import { WEBHOOK_PROCESSING_STATUS_ENUM } from 'src/webhooks/enums/webhook-processing-status.enum';
import { WEBHOOK_PROVIDER_ENUM } from 'src/webhooks/enums/webhook-provider.enum';

import { WebhookMetricsService } from './webhook-metrics.service';

const BACKLOG_STATUSES = [
  WEBHOOK_PROCESSING_STATUS_ENUM.RECEIVED,
  WEBHOOK_PROCESSING_STATUS_ENUM.FAILED,
];

/** Una fila del agrupado de `webhook_events`. Postgres devuelve los números como texto. */
interface BacklogRow {
  provider: WEBHOOK_PROVIDER_ENUM;
  status: WEBHOOK_PROCESSING_STATUS_ENUM;
  pending: string;
  oldestSeconds: string;
}

/**
 * Publica cada minuto cuántas entregas siguen sin resolver en `webhook_events` y hace cuánto. Sólo
 * lee: nunca modifica una fila.
 *
 * No cuenta los rechazos de auditoría (`provider_event_id IS NULL`). Quedan en FAILED para siempre,
 * nadie los reintenta, y los puede crear cualquiera con un POST sin firma: contarlos dejaría el
 * backlog creciendo sin que haya nada que resolver. Se ven en `webhook_deliveries_total` con
 * `outcome="rejected"`.
 *
 * La antigüedad sale de `received_at`, que se renueva con cada reintento del proveedor: mide cuánto
 * lleva la fila sin un intento nuevo, no cuánto lleva sin resolverse desde la primera entrega.
 */
@Injectable()
export class WebhookBacklogMetricsCollector implements OnApplicationBootstrap {
  private readonly logger = new Logger(WebhookBacklogMetricsCollector.name);

  constructor(
    @InjectRepository(WebhookEventEntity)
    private readonly webhookEventRepository: Repository<WebhookEventEntity>,
    private readonly webhookMetrics: WebhookMetricsService,
  ) {}

  /**
   * Publica el backlog al arrancar, para no dejar el primer minuto sin series.
   *
   * @returns Cuando termina la primera recolección.
   *
   * @example
   * ```ts
   * // Lo invoca Nest al terminar de inicializar la aplicación.
   * ```
   */
  onApplicationBootstrap(): Promise<void> {
    return this.collect();
  }

  /**
   * Consulta el backlog y actualiza las métricas.
   *
   * Recorre todas las combinaciones de proveedor y estado para dejar en `0` las que ya no tienen
   * filas: Prometheus conservaría el último valor de una serie que deja de actualizarse. Si la
   * consulta falla no toca nada, porque publicar `0` diría que no hay pendientes sin saberlo.
   *
   * @returns Nada; los errores se registran en el log.
   *
   * @example
   * ```ts
   * await collector.collect();
   * ```
   */
  @Cron(CronExpression.EVERY_MINUTE, { waitForCompletion: true })
  async collect(): Promise<void> {
    if (!this.webhookMetrics.isEnabled()) return;

    try {
      const rows = await this.findBacklog();

      for (const provider of Object.values(WEBHOOK_PROVIDER_ENUM)) {
        for (const status of BACKLOG_STATUSES) {
          const row = rows.find(
            (candidate) =>
              candidate.provider === provider && candidate.status === status,
          );

          this.webhookMetrics.setBacklog(
            provider,
            status,
            Number(row?.pending ?? 0),
            Math.max(0, Number(row?.oldestSeconds ?? 0)),
          );
        }
      }
    } catch (error) {
      this.logger.error(
        'No se pudo recolectar el backlog de webhooks.',
        error instanceof Error ? error.stack : undefined,
      );
    }
  }

  /**
   * Agrupa por proveedor y estado las filas sin resolver. La antigüedad se calcula con el reloj de
   * la base, el mismo contra el que se compara `received_at`.
   *
   * @returns Una fila por combinación con entregas pendientes.
   *
   * @throws {QueryFailedError} Si falla la consulta.
   *
   * @example
   * ```ts
   * const rows = await this.findBacklog();
   * ```
   */
  private findBacklog(): Promise<BacklogRow[]> {
    return this.webhookEventRepository
      .createQueryBuilder('event')
      .select('event.provider', 'provider')
      .addSelect('event.processingStatus', 'status')
      .addSelect('COUNT(*)', 'pending')
      .addSelect(
        'EXTRACT(EPOCH FROM (now() - MIN(event.receivedAt)))',
        'oldestSeconds',
      )
      .where('event.processingStatus IN (:...statuses)', {
        statuses: BACKLOG_STATUSES,
      })
      .andWhere('event.providerEventId IS NOT NULL')
      .groupBy('event.provider')
      .addGroupBy('event.processingStatus')
      .getRawMany<BacklogRow>();
  }
}
