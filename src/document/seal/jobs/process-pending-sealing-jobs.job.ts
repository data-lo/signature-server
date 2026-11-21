import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';

import { SealingWorkerConfig } from '../config/sealing-worker.config';
import {
  DocumentSealingJobFailedException,
  SealingJobLeaseLostException,
} from '../exceptions/seal.exceptions';
import { SealingFailure } from '../interfaces/sealing-failure.interface';
import {
  SealingRetryDecision,
  SealingRetryPolicy,
} from '../policies/sealing-retry.policy';
import { SealingJobLeaseService } from '../services/sealing-job-lease.service';
import {
  ClaimDueSealingJobsUseCase,
  ClaimedSealingJob,
} from '../use-cases/claim-due-sealing-jobs.use-case';
import { ProcessDocumentSealingJobUseCase } from '../use-cases/process-document-sealing-job.use-case';
import { classifySealingError } from '../utils/classify-sealing-error.util';

/** Resultado de una pasada del worker. */
export interface SealingWorkerRunSummary {
  claimed: number;
  completed: number;
  failed: number;
  leaseLost: number;
}

/**
 * Worker de sellado: cada minuto reclama los trabajos que tocan y los ejecuta.
 *
 * - **Sin solapes dentro de una instancia**: `waitForCompletion` no arranca una pasada mientras la
 *   anterior sigue. **Entre instancias** lo resuelve Postgres (`FOR UPDATE SKIP LOCKED` en
 *   `ClaimDueSealingJobsUseCase`).
 * - **Concurrencia**: reclama a lo más `SEALING_CONCURRENCY` trabajos, los ejecuta en paralelo y
 *   sólo entonces reclama más, hasta `SEALING_BATCH_SIZE` por pasada. Nunca reclama trabajos que
 *   esperarían su turno con el lease corriendo.
 * - **Lease**: cada trabajo renueva su reclamo con un heartbeat; si lo pierde, el procesador no
 *   empieza la fase siguiente y nada se registra sobre el trabajo, que ahora es de otro.
 * - **Fallos**: se clasifican (`classifySealingError`) y `SealingRetryPolicy` decide si se
 *   reprograma con backoff, queda `DEAD` o va a conciliación.
 * - **`SEALING_WORKER_ENABLED=false`** detiene las pasadas nuevas; los pendientes se quedan en la
 *   tabla y se retoman al volver a activarlo.
 *
 * `ScheduleModule.forRoot()` vive en `WebhooksModule` y descubre este `@Cron` en cualquier módulo.
 */
@Injectable()
export class ProcessPendingSealingJobsJob {
  private readonly logger = new Logger(ProcessPendingSealingJobsJob.name);

  constructor(
    private readonly config: SealingWorkerConfig,
    private readonly claimDueJobs: ClaimDueSealingJobsUseCase,
    private readonly processor: ProcessDocumentSealingJobUseCase,
    private readonly leases: SealingJobLeaseService,
    private readonly retryPolicy: SealingRetryPolicy,
  ) {}

  /**
   * Pasada programada. Nunca lanza: un fallo se registra y no tumba el scheduler.
   *
   * @returns Nada.
   *
   * @example
   * ```ts
   * await job.run();
   * ```
   */
  @Cron(CronExpression.EVERY_MINUTE, {
    name: 'process-pending-sealing-jobs',
    waitForCompletion: true,
  })
  async run(): Promise<void> {
    if (!this.config.settings.enabled) {
      return;
    }
    try {
      const summary = await this.drain();
      if (summary.claimed > 0) {
        this.logger.log(
          JSON.stringify({ event: 'sealing_worker.run', ...summary }),
        );
      }
    } catch (error) {
      this.logger.error(
        JSON.stringify({
          event: 'sealing_worker.run_failed',
          error: error instanceof Error ? error.name : 'Error',
        }),
        error instanceof Error ? error.stack : undefined,
      );
    }
  }

  /**
   * Reclama y ejecuta trabajos hasta agotar el lote o los pendientes.
   *
   * @returns Cuántos se reclamaron, completaron, fallaron o perdieron su lease.
   *
   * @example
   * ```ts
   * const { completed } = await job.drain();
   * ```
   */
  async drain(): Promise<SealingWorkerRunSummary> {
    const { batchSize, concurrency } = this.config.settings;
    const summary: SealingWorkerRunSummary = {
      claimed: 0,
      completed: 0,
      failed: 0,
      leaseLost: 0,
    };

    while (summary.claimed < batchSize) {
      const jobs = await this.claimDueJobs.execute(
        Math.min(concurrency, batchSize - summary.claimed),
      );
      if (jobs.length === 0) {
        break;
      }
      summary.claimed += jobs.length;

      const outcomes = await Promise.all(jobs.map((job) => this.runOne(job)));
      for (const outcome of outcomes) {
        summary[outcome] += 1;
      }
    }

    return summary;
  }

  /**
   * Ejecuta un trabajo reclamado con su heartbeat y registra el resultado.
   *
   * @param job - Trabajo recién reclamado.
   * @returns Cómo terminó.
   *
   * @example
   * ```ts
   * const outcome = await this.runOne(job); // 'completed'
   * ```
   */
  private async runOne(
    job: ClaimedSealingJob,
  ): Promise<'completed' | 'failed' | 'leaseLost'> {
    const startedAt = Date.now();
    const heartbeat = this.leases.startHeartbeat(job.id, job.leaseToken);
    const base = {
      jobId: job.id,
      documentId: job.documentId,
      attemptCount: job.attemptCount,
      recovered: job.recovered,
    };

    try {
      await this.processor.execute(job.id, job.leaseToken, heartbeat.signal);
      this.logger.log(
        JSON.stringify({
          event: 'sealing_job.completed',
          ...base,
          phase: job.phase,
          durationMs: Date.now() - startedAt,
        }),
      );
      return 'completed';
    } catch (error) {
      if (error instanceof SealingJobLeaseLostException) {
        this.logLeaseLost(base, startedAt);
        return 'leaseLost';
      }

      const failure =
        error instanceof DocumentSealingJobFailedException
          ? error.failure
          : classifySealingError(error, job.phase);
      return this.recordFailure(job, failure, base, startedAt);
    } finally {
      heartbeat.stop();
    }
  }

  /**
   * Decide y registra el siguiente estado de un trabajo fallido.
   *
   * @param job - Trabajo.
   * @param failure - Fallo clasificado.
   * @param base - Campos comunes del log.
   * @param startedAt - Inicio del intento, para `durationMs`.
   * @returns `failed`, o `leaseLost` si el trabajo ya era de otro worker.
   *
   * @example
   * ```ts
   * return this.recordFailure(job, failure, base, startedAt);
   * ```
   */
  private async recordFailure(
    job: ClaimedSealingJob,
    failure: SealingFailure,
    base: Record<string, unknown>,
    startedAt: number,
  ): Promise<'failed' | 'leaseLost'> {
    const decision: SealingRetryDecision = this.retryPolicy.decide(
      job.attemptCount,
      failure,
    );

    let recorded: boolean;
    try {
      recorded = await this.leases.recordFailure(
        job.id,
        job.leaseToken,
        decision,
        failure,
      );
    } catch (error) {
      // Sin poder escribir, el lease vence y otro intento recupera el trabajo.
      this.logger.error(
        JSON.stringify({
          event: 'sealing_job.failure_not_recorded',
          ...base,
          errorCode: failure.code,
          error: error instanceof Error ? error.name : 'Error',
        }),
      );
      return 'failed';
    }

    if (!recorded) {
      this.logLeaseLost(base, startedAt);
      return 'leaseLost';
    }

    this.logger.warn(
      JSON.stringify({
        event: 'sealing_job.failed',
        ...base,
        phase: failure.phase,
        kind: failure.kind,
        errorCode: failure.code,
        upstreamStatus: failure.upstreamStatus,
        status: decision.status,
        exhausted: decision.exhausted,
        durationMs: Date.now() - startedAt,
        nextAttemptAt: decision.nextAttemptAt?.toISOString() ?? null,
      }),
    );
    return 'failed';
  }

  /**
   * Registra que el trabajo dejó de ser de este worker.
   *
   * @param base - Campos comunes del log.
   * @param startedAt - Inicio del intento.
   * @returns Nada.
   *
   * @example
   * ```ts
   * this.logLeaseLost(base, startedAt);
   * ```
   */
  private logLeaseLost(base: Record<string, unknown>, startedAt: number): void {
    this.logger.warn(
      JSON.stringify({
        event: 'sealing_job.lease_lost',
        ...base,
        durationMs: Date.now() - startedAt,
      }),
    );
  }
}
