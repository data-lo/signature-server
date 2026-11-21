import { SEALING_JOB_STATUS_ENUM } from '../enums/sealing-job-status.enum';
import { SEALING_PHASE_ENUM } from '../enums/sealing-phase.enum';
import {
  SEALING_FAILURE_CODE_ENUM,
  SEALING_FAILURE_KIND_ENUM,
  SealingFailure,
} from '../interfaces/sealing-failure.interface';
import { decideSealingRetry, SEALING_BACKOFF_MS } from './sealing-retry.policy';

const NOW = new Date('2026-11-19T20:00:00.000Z');
const MIN = 60_000;
const HOUR = 60 * MIN;

function failure(overrides: Partial<SealingFailure> = {}): SealingFailure {
  return {
    kind: SEALING_FAILURE_KIND_ENUM.RETRYABLE,
    code: SEALING_FAILURE_CODE_ENUM.SEAL_PROVIDER_UNAVAILABLE,
    message: 'Seal Service no respondió.',
    phase: SEALING_PHASE_ENUM.GENERATING_SEAL,
    upstreamStatus: null,
    retryAfterMs: null,
    maxAttempts: null,
    ...overrides,
  };
}

/** Espera elegida, sin variación (`random` = 0.5). */
function delayAfter(attemptCount: number, f: SealingFailure = failure()) {
  const decision = decideSealingRetry({
    attemptCount,
    failure: f,
    maxAttempts: 8,
    now: NOW,
    random: () => 0.5,
  });
  return decision.nextAttemptAt
    ? decision.nextAttemptAt.getTime() - NOW.getTime()
    : null;
}

describe('decideSealingRetry', () => {
  it('sigue la escalera 1 min → 5 min → 15 min → 1 h → 4 h → 12 h → 12 h', () => {
    expect([1, 2, 3, 4, 5, 6, 7].map((attempt) => delayAfter(attempt))).toEqual(
      [1 * MIN, 5 * MIN, 15 * MIN, 1 * HOUR, 4 * HOUR, 12 * HOUR, 12 * HOUR],
    );
    expect(SEALING_BACKOFF_MS).toHaveLength(7);
  });

  it('la octava ejecución fallida agota los intentos: DEAD, sin reprogramar', () => {
    expect(
      decideSealingRetry({
        attemptCount: 8,
        failure: failure(),
        maxAttempts: 8,
        now: NOW,
      }),
    ).toEqual({
      status: SEALING_JOB_STATUS_ENUM.DEAD,
      nextAttemptAt: null,
      exhausted: true,
    });
  });

  it('la variación queda acotada a ±20 %', () => {
    const at = (random: number) =>
      decideSealingRetry({
        attemptCount: 2,
        failure: failure(),
        maxAttempts: 8,
        now: NOW,
        random: () => random,
      }).nextAttemptAt!.getTime() - NOW.getTime();

    expect(at(0)).toBe(4 * MIN);
    expect(at(0.999999)).toBeLessThanOrEqual(6 * MIN);
    expect(at(0.999999)).toBeGreaterThan(5.99 * MIN);
  });

  it('respeta un Retry-After mayor que el backoff', () => {
    expect(delayAfter(1, failure({ retryAfterMs: 10 * MIN }))).toBe(10 * MIN);
  });

  it('un Retry-After menor que el backoff no lo acorta', () => {
    expect(delayAfter(3, failure({ retryAfterMs: 30_000 }))).toBe(15 * MIN);
  });

  it('OCSP unknown usa su propio tope, más bajo', () => {
    const unknown = failure({
      code: SEALING_FAILURE_CODE_ENUM.OCSP_STATUS_UNKNOWN,
      maxAttempts: 3,
    });

    expect(
      decideSealingRetry({
        attemptCount: 2,
        failure: unknown,
        maxAttempts: 8,
        now: NOW,
      }).status,
    ).toBe(SEALING_JOB_STATUS_ENUM.RETRY_SCHEDULED);
    expect(
      decideSealingRetry({
        attemptCount: 3,
        failure: unknown,
        maxAttempts: 8,
        now: NOW,
      }),
    ).toEqual(
      expect.objectContaining({
        status: SEALING_JOB_STATUS_ENUM.DEAD,
        exhausted: true,
      }),
    );
  });

  it('un fallo terminal queda DEAD en el primer intento', () => {
    expect(
      decideSealingRetry({
        attemptCount: 1,
        failure: failure({ kind: SEALING_FAILURE_KIND_ENUM.TERMINAL }),
        maxAttempts: 8,
      }),
    ).toEqual({
      status: SEALING_JOB_STATUS_ENUM.DEAD,
      nextAttemptAt: null,
      exhausted: false,
    });
  });

  it('un resultado incierto va a conciliación sin reprogramar', () => {
    expect(
      decideSealingRetry({
        attemptCount: 1,
        failure: failure({
          kind: SEALING_FAILURE_KIND_ENUM.RECONCILIATION_REQUIRED,
        }),
        maxAttempts: 8,
      }),
    ).toEqual({
      status: SEALING_JOB_STATUS_ENUM.RECONCILIATION_REQUIRED,
      nextAttemptAt: null,
      exhausted: false,
    });
  });
});
