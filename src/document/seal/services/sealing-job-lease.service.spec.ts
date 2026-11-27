import { DEFAULT_SEALING_WORKER_SETTINGS } from '../config/sealing-worker.config';
import { SealingJobLeaseService } from './sealing-job-lease.service';

describe('SealingJobLeaseService.startHeartbeat', () => {
  let service: SealingJobLeaseService;
  let renew: jest.SpyInstance;

  beforeEach(() => {
    jest.useFakeTimers();
    service = new SealingJobLeaseService(
      {} as never,
      {
        settings: { ...DEFAULT_SEALING_WORKER_SETTINGS, heartbeatSeconds: 30 },
      } as never,
    );
    renew = jest.spyOn(service, 'renew');
  });

  afterEach(() => jest.useRealTimers());

  /** Avanza el reloj y deja correr las promesas de la renovación. */
  async function tick(ms: number) {
    await jest.advanceTimersByTimeAsync(ms);
  }

  it('renueva cada 30 s mientras el trabajo sigue siendo suyo', async () => {
    renew.mockResolvedValue(true);
    const heartbeat = service.startHeartbeat('job-1', 'lease-1');

    await tick(29_000);
    expect(renew).not.toHaveBeenCalled();
    await tick(1_000);
    await tick(30_000);

    expect(renew).toHaveBeenCalledTimes(2);
    expect(renew).toHaveBeenCalledWith('job-1', 'lease-1');
    expect(heartbeat.signal.aborted).toBe(false);
    heartbeat.stop();
  });

  it('si la renovación no encuentra el trabajo, aborta la señal y deja de renovar', async () => {
    renew.mockResolvedValue(false);
    const heartbeat = service.startHeartbeat('job-1', 'lease-1');

    await tick(30_000);
    await tick(60_000);

    expect(heartbeat.signal.aborted).toBe(true);
    expect(renew).toHaveBeenCalledTimes(1);
  });

  it('un fallo de la base al renovar no aborta: lo intenta en el siguiente latido', async () => {
    renew.mockRejectedValueOnce(new Error('db')).mockResolvedValue(true);
    const heartbeat = service.startHeartbeat('job-1', 'lease-1');

    await tick(60_000);

    expect(heartbeat.signal.aborted).toBe(false);
    expect(renew).toHaveBeenCalledTimes(2);
    heartbeat.stop();
  });

  it('stop detiene las renovaciones', async () => {
    renew.mockResolvedValue(true);
    service.startHeartbeat('job-1', 'lease-1').stop();

    await tick(90_000);

    expect(renew).not.toHaveBeenCalled();
  });
});
