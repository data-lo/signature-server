import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { SealingWorkerConfig } from '../config/sealing-worker.config';
import { DocumentSealingJobEntity } from '../entities/document-sealing-job.entity';
import { SEALING_JOB_STATUS_ENUM } from '../enums/sealing-job-status.enum';
import { SealingFailure } from '../interfaces/sealing-failure.interface';
import { SealingRetryDecision } from '../policies/sealing-retry.policy';

/** Heartbeat de un trabajo en curso. */
export interface SealingJobHeartbeat {
  /** Se aborta en cuanto una renovación encuentra que el trabajo ya no es de este worker. */
  signal: AbortSignal;
  /** Detiene las renovaciones. Llamarlo dos veces no hace nada. */
  stop(): void;
}

/**
 * Mantiene y libera los reclamos (`lease_token`, `lease_expires_at`) de los trabajos de sellado.
 *
 * Toda escritura va condicionada a `id`, `status = PROCESSING` y el `lease_token` del worker: uno
 * cuyo lease venció y otro recuperó no puede renovar, reprogramar ni cerrar el trabajo del nuevo
 * dueño. Si el UPDATE no toca ninguna fila, el reclamo se perdió.
 */
@Injectable()
export class SealingJobLeaseService {
  private readonly logger = new Logger(SealingJobLeaseService.name);

  constructor(
    @InjectRepository(DocumentSealingJobEntity)
    private readonly jobRepository: Repository<DocumentSealingJobEntity>,
    private readonly config: SealingWorkerConfig,
  ) {}

  /**
   * Extiende el lease `SEALING_LEASE_SECONDS` desde ahora.
   *
   * @param jobId - Trabajo.
   * @param leaseToken - Token del reclamo.
   * @returns `true` si el trabajo sigue siendo de este worker.
   *
   * @example
   * ```ts
   * if (!(await leases.renew(job.id, job.leaseToken))) stop();
   * ```
   */
  async renew(jobId: string, leaseToken: string): Promise<boolean> {
    const result = await this.jobRepository
      .createQueryBuilder()
      .update(DocumentSealingJobEntity)
      .set({
        leaseExpiresAt: () =>
          `now() + make_interval(secs => ${this.config.settings.leaseSeconds})`,
      })
      .where('id = :jobId', { jobId })
      .andWhere('status = :status', {
        status: SEALING_JOB_STATUS_ENUM.PROCESSING,
      })
      .andWhere('lease_token = :leaseToken', { leaseToken })
      .execute();

    return Boolean(result.affected);
  }

  /**
   * Renueva el lease cada `SEALING_HEARTBEAT_SECONDS` mientras el trabajo corre.
   *
   * Si una renovación no encuentra la fila (otro worker la recuperó), aborta `signal` y deja de
   * renovar: el procesador lo revisa antes de cada fase. Un fallo de la base al renovar sólo se
   * registra; si persiste, el lease vence y otro worker recupera el trabajo.
   *
   * @param jobId - Trabajo.
   * @param leaseToken - Token del reclamo.
   * @returns El heartbeat, con su señal y su `stop`.
   *
   * @example
   * ```ts
   * const heartbeat = leases.startHeartbeat(job.id, job.leaseToken);
   * try { await processor.execute(job.id, job.leaseToken, heartbeat.signal); }
   * finally { heartbeat.stop(); }
   * ```
   */
  startHeartbeat(jobId: string, leaseToken: string): SealingJobHeartbeat {
    const controller = new AbortController();
    let renewing = false;

    const timer = setInterval(() => {
      if (renewing || controller.signal.aborted) {
        return;
      }
      renewing = true;
      this.renew(jobId, leaseToken)
        .then((owned) => {
          if (!owned) {
            this.logger.warn(
              JSON.stringify({
                event: 'sealing_job.lease_lost',
                jobId,
              }),
            );
            controller.abort();
            clearInterval(timer);
          }
        })
        .catch((error: unknown) => {
          this.logger.warn(
            JSON.stringify({
              event: 'sealing_job.lease_renewal_failed',
              jobId,
              error: error instanceof Error ? error.name : 'Error',
            }),
          );
        })
        .finally(() => {
          renewing = false;
        });
    }, this.config.settings.heartbeatSeconds * 1000);
    // No mantiene vivo el proceso al apagarlo.
    timer.unref?.();

    return {
      signal: controller.signal,
      stop: () => clearInterval(timer),
    };
  }

  /**
   * Registra un intento fallido y libera el reclamo, si el trabajo sigue siendo de este worker.
   *
   * Conserva la fase, el payload y la evidencia ya obtenida; sólo cambian el estado, cuándo vuelve a
   * ser elegible y el último error.
   *
   * @param jobId - Trabajo.
   * @param leaseToken - Token del reclamo.
   * @param decision - Lo que decidió `SealingRetryPolicy`.
   * @param failure - Fallo clasificado.
   * @returns `true` si se registró; `false` si el trabajo ya era de otro worker.
   *
   * @example
   * ```ts
   * await leases.recordFailure(job.id, job.leaseToken, decision, error.failure);
   * ```
   */
  async recordFailure(
    jobId: string,
    leaseToken: string,
    decision: SealingRetryDecision,
    failure: SealingFailure,
  ): Promise<boolean> {
    const result = await this.jobRepository
      .createQueryBuilder()
      .update(DocumentSealingJobEntity)
      .set({
        status: decision.status,
        ...(decision.nextAttemptAt && {
          nextAttemptAt: decision.nextAttemptAt,
        }),
        leaseToken: null,
        leaseExpiresAt: null,
        lastErrorCode: failure.code,
        lastErrorMessage: decision.exhausted
          ? `${failure.message} Se agotaron las ejecuciones permitidas.`
          : failure.message,
        lastUpstreamStatus: failure.upstreamStatus,
      })
      .where('id = :jobId', { jobId })
      .andWhere('status = :status', {
        status: SEALING_JOB_STATUS_ENUM.PROCESSING,
      })
      .andWhere('lease_token = :leaseToken', { leaseToken })
      .execute();

    return Boolean(result.affected);
  }
}
