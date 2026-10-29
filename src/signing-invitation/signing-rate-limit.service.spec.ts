import {
  OTP_SEND_COOLDOWN,
  OTP_SEND_HOURLY,
  OTP_VERIFY_FAILURES,
  SigningRateLimitException,
  SigningRateLimitService,
} from './signing-rate-limit.service';

function memoryRedis() {
  const counters = new Map<string, number>();
  return {
    counters,
    incrementWithExpiry: jest.fn(async (key: string) => {
      const next = (counters.get(key) ?? 0) + 1;
      counters.set(key, next);
      return next;
    }),
    get: jest.fn(async (key: string) =>
      counters.has(key) ? String(counters.get(key)) : null,
    ),
    del: jest.fn(async (key: string) => Number(counters.delete(key))),
  };
}

describe('SigningRateLimitService', () => {
  let redis: ReturnType<typeof memoryRedis>;
  let limits: SigningRateLimitService;

  beforeEach(() => {
    redis = memoryRedis();
    limits = new SigningRateLimitService(redis as never);
  });

  it('el segundo código en el mismo minuto se rechaza con 429', async () => {
    await limits.consume('inv:1', [OTP_SEND_COOLDOWN, OTP_SEND_HOURLY]);
    await expect(
      limits.consume('inv:1', [OTP_SEND_COOLDOWN, OTP_SEND_HOURLY]),
    ).rejects.toBeInstanceOf(SigningRateLimitException);
  });

  it('cada invitación lleva su propio contador', async () => {
    await limits.consume('inv:1', [OTP_SEND_COOLDOWN]);
    await expect(
      limits.consume('inv:2', [OTP_SEND_COOLDOWN]),
    ).resolves.toBeUndefined();
  });

  it('los fallos se cuentan aparte y bloquean al llegar al límite; validar bien los reinicia', async () => {
    for (let i = 0; i < OTP_VERIFY_FAILURES.limit; i += 1) {
      await limits.assertAvailable('inv:1', OTP_VERIFY_FAILURES);
      await limits.record('inv:1', OTP_VERIFY_FAILURES);
    }
    await expect(
      limits.assertAvailable('inv:1', OTP_VERIFY_FAILURES),
    ).rejects.toBeInstanceOf(SigningRateLimitException);

    await limits.reset('inv:1', OTP_VERIFY_FAILURES);
    await expect(
      limits.assertAvailable('inv:1', OTP_VERIFY_FAILURES),
    ).resolves.toBeUndefined();
  });

  it('las claves llevan ids, nunca tokens', async () => {
    await limits.consume('inv:inv-1', [OTP_SEND_COOLDOWN]);
    expect([...redis.counters.keys()]).toEqual([
      'signing-rate:otp-send-cooldown:inv:inv-1',
    ]);
  });
});
