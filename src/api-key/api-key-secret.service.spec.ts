import { ConfigService } from '@nestjs/config';
import { createHmac } from 'crypto';

import {
  API_KEY_TOKEN_PREFIX,
  ApiKeySecretService,
} from './api-key-secret.service';
import { ApiKeyNotConfiguredException } from './exceptions/api-key.exceptions';

const PEPPER = 'pepper-de-prueba-con-al-menos-treinta-y-dos-caracteres';

function serviceWith(pepper: string | undefined): ApiKeySecretService {
  return new ApiKeySecretService({
    get: jest.fn().mockReturnValue(pepper),
  } as unknown as ConfigService);
}

describe('ApiKeySecretService', () => {
  it('arma la llave como fma_live_<publicId>_<secret>, con el prefijo visible', () => {
    const { publicId, keyPrefix, key } = serviceWith(PEPPER).generate();

    expect(publicId).toMatch(/^[0-9a-f]{16}$/);
    expect(keyPrefix).toBe(`${API_KEY_TOKEN_PREFIX}_${publicId}`);
    expect(key.startsWith(`${keyPrefix}_`)).toBe(true);
  });

  it('el secreto tiene al menos 32 bytes aleatorios', () => {
    const { key, keyPrefix } = serviceWith(PEPPER).generate();
    const secret = key.slice(keyPrefix.length + 1);

    expect(Buffer.from(secret, 'base64url').length).toBeGreaterThanOrEqual(32);
  });

  it('guarda el HMAC-SHA-256 del secreto con el pepper, nunca el secreto', () => {
    const { key, keyPrefix, secretHash } = serviceWith(PEPPER).generate();
    const secret = key.slice(keyPrefix.length + 1);

    expect(secretHash).toBe(
      createHmac('sha256', PEPPER).update(secret).digest('hex'),
    );
    expect(secretHash).not.toContain(secret);
  });

  it('dos llaves seguidas no comparten publicId ni secreto', () => {
    const service = serviceWith(PEPPER);
    const first = service.generate();
    const second = service.generate();

    expect(first.publicId).not.toBe(second.publicId);
    expect(first.secretHash).not.toBe(second.secretHash);
  });

  it.each([undefined, '', 'corto'])(
    'falla sin un pepper de al menos 32 caracteres (%p)',
    (pepper) => {
      expect(() => serviceWith(pepper).generate()).toThrow(
        ApiKeyNotConfiguredException,
      );
    },
  );
});
