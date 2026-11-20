import {
  DEFAULT_SEALING_WORKER_SETTINGS,
  parseSealingWorkerSettings,
} from './sealing-worker.config';

const from = (env: Record<string, string>) => (key: string) => env[key];

describe('parseSealingWorkerSettings', () => {
  it('sin variables usa los valores iniciales, con el worker apagado', () => {
    expect(parseSealingWorkerSettings(from({}))).toEqual(
      DEFAULT_SEALING_WORKER_SETTINGS,
    );
    expect(DEFAULT_SEALING_WORKER_SETTINGS).toEqual({
      enabled: false,
      batchSize: 10,
      concurrency: 2,
      maxAttempts: 8,
      leaseSeconds: 120,
      heartbeatSeconds: 30,
    });
  });

  it('lee los valores definidos', () => {
    expect(
      parseSealingWorkerSettings(
        from({
          SEALING_WORKER_ENABLED: 'TRUE',
          SEALING_BATCH_SIZE: '20',
          SEALING_CONCURRENCY: '4',
          SEALING_MAX_ATTEMPTS: '5',
          SEALING_LEASE_SECONDS: '300',
          SEALING_HEARTBEAT_SECONDS: '60',
        }),
      ),
    ).toEqual({
      enabled: true,
      batchSize: 20,
      concurrency: 4,
      maxAttempts: 5,
      leaseSeconds: 300,
      heartbeatSeconds: 60,
    });
  });

  it.each([
    ['SEALING_WORKER_ENABLED', 'si'],
    ['SEALING_BATCH_SIZE', '0'],
    ['SEALING_CONCURRENCY', '-1'],
    ['SEALING_LEASE_SECONDS', '12O'],
  ])('detiene el arranque con %s=%s', (key, value) => {
    expect(() => parseSealingWorkerSettings(from({ [key]: value }))).toThrow(
      key,
    );
  });

  it('exige un heartbeat menor que el lease', () => {
    expect(() =>
      parseSealingWorkerSettings(
        from({ SEALING_LEASE_SECONDS: '30', SEALING_HEARTBEAT_SECONDS: '30' }),
      ),
    ).toThrow('SEALING_HEARTBEAT_SECONDS');
  });
});
