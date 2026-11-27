import { DEFAULT_SEALING_WORKER_SETTINGS } from '../config/sealing-worker.config';
import { SEALING_JOB_STATUS_ENUM } from '../enums/sealing-job-status.enum';
import { SEALING_PHASE_ENUM } from '../enums/sealing-phase.enum';
import {
  DocumentSealingJobFailedException,
  SealingJobLeaseLostException,
  SealProviderUnavailableException,
} from '../exceptions/seal.exceptions';
import {
  SEALING_FAILURE_CODE_ENUM,
  SEALING_FAILURE_KIND_ENUM,
} from '../interfaces/sealing-failure.interface';
import { ClaimedSealingJob } from '../use-cases/claim-due-sealing-jobs.use-case';
import { ProcessPendingSealingJobsJob } from './process-pending-sealing-jobs.job';

function claimed(id: string, attemptCount = 1): ClaimedSealingJob {
  return {
    id,
    documentId: `doc-${id}`,
    leaseToken: `lease-${id}`,
    attemptCount,
    phase: SEALING_PHASE_ENUM.GENERATING_SEAL,
    recovered: false,
  };
}

describe('ProcessPendingSealingJobsJob', () => {
  let settings: typeof DEFAULT_SEALING_WORKER_SETTINGS;
  let queue: ClaimedSealingJob[];
  let claim: { execute: jest.Mock };
  let processor: { execute: jest.Mock };
  let leases: {
    startHeartbeat: jest.Mock;
    recordFailure: jest.Mock;
  };
  let policy: { decide: jest.Mock };
  let stops: jest.Mock;
  let job: ProcessPendingSealingJobsJob;
  let running: number;
  let maxRunning: number;

  beforeEach(() => {
    settings = { ...DEFAULT_SEALING_WORKER_SETTINGS, enabled: true };
    queue = [];
    running = 0;
    maxRunning = 0;
    claim = {
      execute: jest.fn(async (limit: number) => queue.splice(0, limit)),
    };
    processor = {
      execute: jest.fn(async () => {
        running += 1;
        maxRunning = Math.max(maxRunning, running);
        await new Promise((resolve) => setImmediate(resolve));
        running -= 1;
      }),
    };
    stops = jest.fn();
    leases = {
      startHeartbeat: jest.fn(() => ({
        signal: new AbortController().signal,
        stop: stops,
      })),
      recordFailure: jest.fn().mockResolvedValue(true),
    };
    policy = {
      decide: jest.fn().mockReturnValue({
        status: SEALING_JOB_STATUS_ENUM.RETRY_SCHEDULED,
        nextAttemptAt: new Date('2026-11-19T20:01:00.000Z'),
        exhausted: false,
      }),
    };
    job = new ProcessPendingSealingJobsJob(
      { settings } as never,
      claim as never,
      processor as never,
      leases as never,
      policy as never,
    );
  });

  it('apagado (SEALING_WORKER_ENABLED=false) no reclama nada', async () => {
    settings.enabled = false;
    queue = [claimed('a')];

    await job.run();

    expect(claim.execute).not.toHaveBeenCalled();
    expect(queue).toHaveLength(1);
  });

  it('reclama sólo los huecos de concurrencia y respeta el lote', async () => {
    settings.concurrency = 2;
    settings.batchSize = 5;
    queue = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((id) => claimed(id));

    const summary = await job.drain();

    expect(claim.execute.mock.calls.map(([limit]) => limit)).toEqual([2, 2, 1]);
    expect(summary).toEqual({
      claimed: 5,
      completed: 5,
      failed: 0,
      leaseLost: 0,
    });
    expect(maxRunning).toBe(2);
    // Los otros dos siguen pendientes para la siguiente pasada.
    expect(queue.map((j) => j.id)).toEqual(['f', 'g']);
  });

  it('ejecuta cada trabajo con su token y la señal del heartbeat, y siempre lo detiene', async () => {
    queue = [claimed('a')];
    processor.execute.mockRejectedValueOnce(new Error('boom'));

    await job.drain();

    expect(leases.startHeartbeat).toHaveBeenCalledWith('a', 'lease-a');
    expect(processor.execute).toHaveBeenCalledWith(
      'a',
      'lease-a',
      expect.any(AbortSignal),
    );
    expect(stops).toHaveBeenCalledTimes(1);
  });

  it('un fallo tipado pasa por la política y se registra con el token', async () => {
    const failure = {
      kind: SEALING_FAILURE_KIND_ENUM.RETRYABLE,
      code: SEALING_FAILURE_CODE_ENUM.SEAL_PROVIDER_UNAVAILABLE,
      message: 'Seal Service no respondió.',
      phase: SEALING_PHASE_ENUM.GENERATING_SEAL,
      upstreamStatus: null,
      retryAfterMs: null,
      maxAttempts: null,
    };
    queue = [claimed('a', 3)];
    processor.execute.mockRejectedValue(
      new DocumentSealingJobFailedException(failure),
    );

    const summary = await job.drain();

    expect(policy.decide).toHaveBeenCalledWith(3, failure);
    expect(leases.recordFailure).toHaveBeenCalledWith(
      'a',
      'lease-a',
      policy.decide.mock.results[0].value,
      failure,
    );
    expect(summary.failed).toBe(1);
  });

  it('un error sin tipar se clasifica antes de decidir', async () => {
    queue = [claimed('a')];
    processor.execute.mockRejectedValue(new SealProviderUnavailableException());

    await job.drain();

    expect(policy.decide).toHaveBeenCalledWith(
      1,
      expect.objectContaining({
        code: SEALING_FAILURE_CODE_ENUM.SEAL_PROVIDER_UNAVAILABLE,
      }),
    );
  });

  it('si perdió el lease no registra nada sobre el trabajo', async () => {
    queue = [claimed('a')];
    processor.execute.mockRejectedValue(new SealingJobLeaseLostException('a'));

    const summary = await job.drain();

    expect(leases.recordFailure).not.toHaveBeenCalled();
    expect(summary.leaseLost).toBe(1);
  });

  it('si al registrar el fallo el trabajo ya es de otro, lo cuenta como lease perdido', async () => {
    queue = [claimed('a')];
    processor.execute.mockRejectedValue(new Error('boom'));
    leases.recordFailure.mockResolvedValue(false);

    expect((await job.drain()).leaseLost).toBe(1);
  });

  it('un fallo de la base al reclamar no tumba el cron', async () => {
    claim.execute.mockRejectedValue(new Error('db caída'));

    await expect(job.run()).resolves.toBeUndefined();
  });
});
