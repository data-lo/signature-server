import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { SealingWorkerConfig } from '../config/sealing-worker.config';
import { SEALING_JOB_STATUS_ENUM } from '../enums/sealing-job-status.enum';
import { SEALING_PHASE_ENUM } from '../enums/sealing-phase.enum';

/** Código con el que se cierran los trabajos que agotaron sus ejecuciones sin poder registrarlo. */
export const SEALING_ATTEMPTS_EXHAUSTED_CODE = 'MAX_ATTEMPTS_REACHED';

/** Un trabajo recién reclamado por esta instancia. */
export interface ClaimedSealingJob {
  id: string;
  documentId: string;
  /** Token del reclamo; toda escritura posterior va condicionada a él. */
  leaseToken: string;
  /** Ejecuciones contando ésta. */
  attemptCount: number;
  phase: SEALING_PHASE_ENUM;
  /** `true` si estaba en `PROCESSING` con el lease vencido: un worker murió a la mitad. */
  recovered: boolean;
}

/** Fila que devuelve el `UPDATE … RETURNING` del reclamo. */
interface ClaimedRow {
  id: string;
  document_id: string;
  lease_token: string;
  attempt_count: number;
  phase: SEALING_PHASE_ENUM;
  previous_status: SEALING_JOB_STATUS_ENUM;
}

/**
 * Reclama de forma atómica los trabajos de sellado que toca ejecutar ya.
 *
 * Todo pasa en una transacción breve, sin llamadas externas:
 * 1. Cierra como `DEAD` los trabajos que ya no pueden ejecutarse otra vez: los `PROCESSING` con el
 *    lease vencido que gastaron su última ejecución (el worker murió en el último intento) y los
 *    pendientes con `attempt_count` ya en el tope (si se bajó `SEALING_MAX_ATTEMPTS`). Sin esto se
 *    quedarían colgados para siempre.
 * 2. Selecciona hasta `limit` trabajos `PENDING`/`RETRY_SCHEDULED` con `next_attempt_at` vencido,
 *    o `PROCESSING` con el lease vencido, con `FOR UPDATE SKIP LOCKED`: dos instancias nunca
 *    reclaman la misma fila; la segunda salta las que la primera tiene bloqueadas.
 * 3. Los pasa a `PROCESSING` con un `lease_token` nuevo por fila, `lease_expires_at` y
 *    `attempt_count + 1`.
 *
 * Las llamadas al SAT, Seal Service y MinIO ocurren DESPUÉS del commit, en el procesador. Quien
 * llama debe pedir sólo los trabajos que va a ejecutar de inmediato, para que su lease no venza
 * esperando en un lote.
 */
@Injectable()
export class ClaimDueSealingJobsUseCase {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly config: SealingWorkerConfig,
  ) {}

  /**
   * @param limit - Trabajos como máximo; normalmente los huecos libres de concurrencia.
   * @returns Los trabajos reclamados, más antiguos primero.
   *
   * @example
   * ```ts
   * const jobs = await claimDueSealingJobs.execute(2);
   * ```
   */
  async execute(limit: number): Promise<ClaimedSealingJob[]> {
    if (limit < 1) {
      return [];
    }
    const { maxAttempts, leaseSeconds } = this.config.settings;

    return this.dataSource.transaction(async (manager) => {
      await manager.query(
        `UPDATE document_sealing_jobs
            SET status = $1,
                lease_token = NULL,
                lease_expires_at = NULL,
                last_error_code = COALESCE(last_error_code, $2),
                last_error_message = COALESCE(last_error_message, 'Se agotaron las ejecuciones permitidas.'),
                updated_at = now()
          WHERE attempt_count >= $3
            AND (
                  (status = $4 AND lease_expires_at < now())
               OR status IN ($5, $6)
            )`,
        [
          SEALING_JOB_STATUS_ENUM.DEAD,
          SEALING_ATTEMPTS_EXHAUSTED_CODE,
          maxAttempts,
          SEALING_JOB_STATUS_ENUM.PROCESSING,
          SEALING_JOB_STATUS_ENUM.PENDING,
          SEALING_JOB_STATUS_ENUM.RETRY_SCHEDULED,
        ],
      );

      const result: unknown = await manager.query(
        `WITH due AS (
           SELECT id, status AS previous_status
             FROM document_sealing_jobs
            WHERE attempt_count < $1
              AND (
                    (status IN ($2, $3) AND next_attempt_at <= now())
                 OR (status = $4 AND lease_expires_at < now())
              )
            ORDER BY next_attempt_at, created_at
            LIMIT $5
            FOR UPDATE SKIP LOCKED
         )
         UPDATE document_sealing_jobs AS job
            SET status = $4,
                lease_token = gen_random_uuid(),
                lease_expires_at = now() + make_interval(secs => $6),
                attempt_count = job.attempt_count + 1,
                updated_at = now()
           FROM due
          WHERE job.id = due.id
         RETURNING job.id, job.document_id, job.lease_token, job.attempt_count, job.phase, due.previous_status`,
        [
          maxAttempts,
          SEALING_JOB_STATUS_ENUM.PENDING,
          SEALING_JOB_STATUS_ENUM.RETRY_SCHEDULED,
          SEALING_JOB_STATUS_ENUM.PROCESSING,
          limit,
          leaseSeconds,
        ],
      );
      // En Postgres, TypeORM devuelve `[filas, conteo]` para un UPDATE con RETURNING.
      const rows = (
        Array.isArray(result) && Array.isArray(result[0]) ? result[0] : result
      ) as ClaimedRow[];

      return rows.map((row) => ({
        id: row.id,
        documentId: row.document_id,
        leaseToken: row.lease_token,
        attemptCount: Number(row.attempt_count),
        phase: row.phase,
        recovered: row.previous_status === SEALING_JOB_STATUS_ENUM.PROCESSING,
      }));
    });
  }
}
