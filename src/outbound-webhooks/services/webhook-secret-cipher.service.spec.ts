import { randomBytes } from 'crypto';

import { WebhookSecretEncryptionUnavailableException } from '../exceptions/outbound-webhook.exceptions';
import {
  WEBHOOK_SECRET_ENCRYPTION_KEY_ENV,
  WebhookSecretCipherService,
} from './webhook-secret-cipher.service';

describe('WebhookSecretCipherService', () => {
  const originalKey = process.env[WEBHOOK_SECRET_ENCRYPTION_KEY_ENV];
  let cipher: WebhookSecretCipherService;

  beforeEach(() => {
    process.env[WEBHOOK_SECRET_ENCRYPTION_KEY_ENV] =
      randomBytes(32).toString('base64');
    cipher = new WebhookSecretCipherService();
  });

  afterAll(() => {
    if (originalKey === undefined) {
      delete process.env[WEBHOOK_SECRET_ENCRYPTION_KEY_ENV];
    } else {
      process.env[WEBHOOK_SECRET_ENCRYPTION_KEY_ENV] = originalKey;
    }
  });

  it('genera secretos whsec_ con 32 bytes en base64url, distintos cada vez', () => {
    const first = cipher.generateSecret();
    const second = cipher.generateSecret();

    expect(first).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/);
    expect(first).not.toBe(second);
  });

  it('cifra con IV aleatorio y descifra al secreto original', () => {
    const secret = cipher.generateSecret();
    const first = cipher.encrypt(secret);
    const second = cipher.encrypt(secret);

    expect(first).toMatch(/^v1:[^:]+:[^:]+:[^:]+$/);
    expect(first).not.toContain(secret);
    expect(first).not.toBe(second);
    expect(cipher.decrypt(first)).toBe(secret);
    expect(cipher.decrypt(second)).toBe(secret);
  });

  it('rechaza un texto cifrado alterado', () => {
    const encrypted = cipher.encrypt(cipher.generateSecret());
    const [version, iv, tag, ciphertext] = encrypted.split(':');
    const tampered = Buffer.from(ciphertext, 'base64url');
    tampered[0] ^= 0xff;

    expect(() =>
      cipher.decrypt(
        [version, iv, tag, tampered.toString('base64url')].join(':'),
      ),
    ).toThrow();
    expect(() => cipher.decrypt('v2:a:b:c')).toThrow(
      'Formato de secreto de webhook cifrado desconocido',
    );
  });

  it.each([
    ['falta', undefined],
    ['no mide 32 bytes', Buffer.alloc(16).toString('base64')],
  ])('responde 503 si la llave %s', (_, value) => {
    if (value === undefined) {
      delete process.env[WEBHOOK_SECRET_ENCRYPTION_KEY_ENV];
    } else {
      process.env[WEBHOOK_SECRET_ENCRYPTION_KEY_ENV] = value;
    }

    expect(() => cipher.encrypt('whsec_x')).toThrow(
      WebhookSecretEncryptionUnavailableException,
    );
  });
});
