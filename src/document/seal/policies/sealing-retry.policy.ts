import { Injectable } from '@nestjs/common';

import { SealingWorkerConfig } from '../config/sealing-worker.config';
import { SEALING_JOB_STATUS_ENUM } from '../enums/sealing-job-status.enum';
import {
  SEALING_FAILURE_KIND_ENUM,
  SealingFailure,
} from '../interfaces/sealing-failure.interface';

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

/**
 * Espera después de cada fallo reintentable: después del 1.er intento 1 min, del 2.º 5 min, y así
 * hasta 12 h. Con 8 ejecuciones totales se usan las siete; si se configuran más, se repite la
 * última.
 */
export const SEALING_BACKOFF_MS: readonly number[] = [
  1 * MINUTE_MS,
  5 * MINUTE_MS,
  15 * MINUTE_MS,
  1 * HOUR_MS,
  4 * HOUR_MS,
  12 * HOUR_MS,
  12 * HOUR_MS,
];

/** Variación aleatoria sobre cada espera: ±20 %, para que los reintentos no coincidan. */
export const SEALING_JITTER_RATIO = 0.2;

/** Qué hacer con un trabajo después de un intento fallido. */
export interface SealingRetryDecision {
  /** `RETRY_SCHEDULED`, `DEAD` o `RECONCILIATION_REQUIRED`. */
  status:
    | SEALING_JOB_STATUS_ENUM.RETRY_SCHEDULED
    | SEALING_JOB_STATUS_ENUM.DEAD
    | SEALING_JOB_STATUS_ENUM.RECONCILIATION_REQUIRED;
  /** Cuándo vuelve a ser elegible; `null` si no se reintenta automáticamente. */
  nextAttemptAt: Date | null;
  /** `true` si quedó `DEAD` por agotar las ejecuciones permitidas. */
  exhausted: boolean;
}

/** Datos para decidir un reintento. */
export interface SealingRetryInput {
  /** Ejecuciones hechas, incluida la que acaba de fallar (`attempt_count` tras el reclamo). */
  attemptCount: number;
  failure: SealingFailure;
  /** Ejecuciones totales permitidas (`SEALING_MAX_ATTEMPTS`). */
  maxAttempts: number;
  now?: Date;
  /** Fuente de aleatoriedad en `[0, 1)`; se inyecta en las pruebas. */
  random?: () => number;
}

/**
 * Decide el siguiente estado de un trabajo fallido. Es la única regla de reintentos del worker.
 *
 * - `RECONCILIATION_REQUIRED` → se detiene para revisión; no se vuelve a seleccionar.
 * - `TERMINAL` → `DEAD`; no se vuelve a seleccionar.
 * - `RETRYABLE` → `RETRY_SCHEDULED` con la espera de `SEALING_BACKOFF_MS` (±20 %), nunca menor que
 *   el `Retry-After` del proveedor. Si ya se hicieron las ejecuciones permitidas (la general o la
 *   propia del fallo, como OCSP `unknown`), `DEAD`.
 *
 * Al quedar `DEAD` se conservan la fase, el error y la evidencia ya obtenida: sólo cambia el estado.
 *
 * @param input - Intentos hechos, fallo, tope y, opcionalmente, reloj y aleatoriedad.
 * @returns El estado y cuándo reintentar.
 *
 * @example
 * ```ts
 * decideSealingRetry({ attemptCount: 1, failure, maxAttempts: 8, random: () => 0.5 });
 * // { status: 'RETRY_SCHEDULED', nextAttemptAt: ahora + 1 min, exhausted: false }
 * ```
 */
export function decideSealingRetry(
  input: SealingRetryInput,
): SealingRetryDecision {
  const { failure, attemptCount } = input;
  const now = input.now ?? new Date();
  const random = input.random ?? Math.random;

  if (failure.kind === SEALING_FAILURE_KIND_ENUM.RECONCILIATION_REQUIRED) {
    return {
      status: SEALING_JOB_STATUS_ENUM.RECONCILIATION_REQUIRED,
      nextAttemptAt: null,
      exhausted: false,
    };
  }
  if (failure.kind === SEALING_FAILURE_KIND_ENUM.TERMINAL) {
    return {
      status: SEALING_JOB_STATUS_ENUM.DEAD,
      nextAttemptAt: null,
      exhausted: false,
    };
  }

  const limit = Math.min(
    input.maxAttempts,
    failure.maxAttempts ?? Number.POSITIVE_INFINITY,
  );
  if (attemptCount >= limit) {
    return {
      status: SEALING_JOB_STATUS_ENUM.DEAD,
      nextAttemptAt: null,
      exhausted: true,
    };
  }

  const base =
    SEALING_BACKOFF_MS[
      Math.min(Math.max(attemptCount, 1), SEALING_BACKOFF_MS.length) - 1
    ];
  const jitter = 1 + (random() * 2 - 1) * SEALING_JITTER_RATIO;
  const delay = Math.max(Math.round(base * jitter), failure.retryAfterMs ?? 0);

  return {
    status: SEALING_JOB_STATUS_ENUM.RETRY_SCHEDULED,
    nextAttemptAt: new Date(now.getTime() + delay),
    exhausted: false,
  };
}

/** `decideSealingRetry` con el tope de `SEALING_MAX_ATTEMPTS`, como provider de Nest. */
@Injectable()
export class SealingRetryPolicy {
  constructor(private readonly config: SealingWorkerConfig) {}

  /**
   * @param attemptCount - Ejecuciones hechas, incluida la que falló.
   * @param failure - Fallo clasificado.
   * @param now - Reloj; por omisión, ahora.
   * @returns El estado y cuándo reintentar.
   *
   * @example
   * ```ts
   * const decision = policy.decide(job.attemptCount, error.failure);
   * ```
   */
  decide(
    attemptCount: number,
    failure: SealingFailure,
    now: Date = new Date(),
  ): SealingRetryDecision {
    return decideSealingRetry({
      attemptCount,
      failure,
      maxAttempts: this.config.settings.maxAttempts,
      now,
    });
  }
}
