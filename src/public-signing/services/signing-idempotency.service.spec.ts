import {
  BadRequestException,
  ConflictException,
  UnprocessableEntityException,
} from '@nestjs/common';

import {
  requireSigningIdempotencyKey,
  SigningIdempotencyService,
  signingRequestFingerprint,
} from './signing-idempotency.service';

/** Redis en memoria con lo que usa el servicio. */
function memoryRedis() {
  const store = new Map<string, string>();
  return {
    store,
    setIfAbsent: jest.fn(async (key: string, value: string) => {
      if (store.has(key)) return false;
      store.set(key, value);
      return true;
    }),
    set: jest.fn(async (key: string, value: string) => {
      store.set(key, value);
      return 'OK';
    }),
    get: jest.fn(async (key: string) => store.get(key) ?? null),
    del: jest.fn(async (key: string) => Number(store.delete(key))),
  };
}

describe('SigningIdempotencyService', () => {
  let redis: ReturnType<typeof memoryRedis>;
  let service: SigningIdempotencyService;

  beforeEach(() => {
    redis = memoryRedis();
    service = new SigningIdempotencyService(redis as never);
  });

  it('ejecuta una vez y devuelve la respuesta guardada al reintentar con la misma petición', async () => {
    const sign = jest.fn(async () => ({ data: { documentCompleted: true } }));

    const first = await service.run('c-1', 'key-1', 'hash-a', sign);
    const replay = await service.run('c-1', 'key-1', 'hash-a', sign);

    expect(sign).toHaveBeenCalledTimes(1);
    expect(replay).toEqual(first);
  });

  it('la clave del cliente no se guarda en claro', async () => {
    await service.run('c-1', 'mi-clave-secreta', 'hash-a', async () => 1);
    expect([...redis.store.keys()].join()).not.toContain('mi-clave-secreta');
  });

  it('422 si la misma clave llega con otra petición', async () => {
    await service.run('c-1', 'key-1', 'hash-a', async () => 1);
    await expect(
      service.run('c-1', 'key-1', 'hash-b', async () => 2),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it('409 mientras la primera sigue en curso', async () => {
    let release!: () => void;
    const pending = service.run(
      'c-1',
      'key-1',
      'hash-a',
      () => new Promise<number>((resolve) => (release = () => resolve(1))),
    );
    await expect(
      service.run('c-1', 'key-1', 'hash-a', async () => 2),
    ).rejects.toBeInstanceOf(ConflictException);
    release();
    await pending;
  });

  it('si la firma falla, libera la clave para reintentar', async () => {
    await expect(
      service.run('c-1', 'key-1', 'hash-a', async () => {
        throw new BadRequestException('no');
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    await expect(
      service.run('c-1', 'key-1', 'hash-a', async () => 'ok'),
    ).resolves.toBe('ok');
  });

  it('las claves de dos firmantes no chocan', async () => {
    await service.run('c-1', 'key-1', 'hash-a', async () => 1);
    await expect(
      service.run('c-2', 'key-1', 'hash-b', async () => 2),
    ).resolves.toBe(2);
  });

  it.each([undefined, '', 'con espacio', 'x'.repeat(256)])(
    'exige un Idempotency-Key válido (%p)',
    (header) => {
      expect(() => requireSigningIdempotencyKey(header)).toThrow(
        BadRequestException,
      );
    },
  );

  it('la huella cambia con los archivos y no depende del orden de llamada', () => {
    const png = { buffer: Buffer.from('png-1') } as Express.Multer.File;
    const other = { buffer: Buffer.from('png-2') } as Express.Multer.File;
    const fields = { documentHash: 'h', geolocation: { latitude: 1 } };

    expect(signingRequestFingerprint('simple', fields, [png])).toBe(
      signingRequestFingerprint('simple', fields, [png]),
    );
    expect(signingRequestFingerprint('simple', fields, [png])).not.toBe(
      signingRequestFingerprint('simple', fields, [other]),
    );
    expect(signingRequestFingerprint('simple', fields)).not.toBe(
      signingRequestFingerprint('advanced', fields),
    );
  });
});
