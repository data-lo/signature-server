import { Injectable, Logger } from '@nestjs/common';
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

import { WebhookSecretEncryptionUnavailableException } from '../exceptions/outbound-webhook.exceptions';
import { WEBHOOK_SECRET_PREFIX } from '../outbound-webhooks.constants';

/** Variable con la llave AES-256 del servidor: 32 bytes en base64. */
export const WEBHOOK_SECRET_ENCRYPTION_KEY_ENV =
  'WEBHOOK_SECRET_ENCRYPTION_KEY';

/** Versión del formato guardado en `encrypted_secret`; permite cambiar de llave o algoritmo. */
const CIPHERTEXT_FORMAT_VERSION = 'v1';
const CIPHER_ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const SECRET_RANDOM_BYTES = 32;

/**
 * Genera, cifra y descifra los secretos HMAC de los webhooks salientes.
 *
 * El secreto se guarda cifrado (AES-256-GCM) y no como hash porque firmar cada entrega exige el
 * texto original. Formato guardado: `v1:<iv>:<authTag>:<ciphertext>`, cada parte en base64url.
 *
 * La llave sale de `WEBHOOK_SECRET_ENCRYPTION_KEY` y se lee al usarla, no al arrancar: sin la
 * variable el servidor arranca igual y sólo la configuración de webhooks responde 503.
 */
@Injectable()
export class WebhookSecretCipherService {
  private readonly logger = new Logger(WebhookSecretCipherService.name);

  /**
   * Genera un secreto nuevo con el formato visible del contrato.
   *
   * @returns `whsec_` seguido de 32 bytes aleatorios en base64url (43 caracteres).
   *
   * @example
   * ```ts
   * cipher.generateSecret(); // 'whsec_Q2hhbmdlTWUtVGhpcy1Jcy1Ob3QtQS1SZWFsLVNlY3JldA'
   * ```
   */
  generateSecret(): string {
    return `${WEBHOOK_SECRET_PREFIX}${randomBytes(SECRET_RANDOM_BYTES).toString('base64url')}`;
  }

  /**
   * Cifra un secreto para guardarlo en `webhook_secret_versions.encrypted_secret`.
   *
   * @param secret - Secreto completo, con `whsec_`.
   * @returns El texto cifrado con el formato `v1:<iv>:<authTag>:<ciphertext>`.
   *
   * @throws {WebhookSecretEncryptionUnavailableException} Si falta la llave o no mide 32 bytes.
   *
   * @example
   * ```ts
   * const encryptedSecret = cipher.encrypt(cipher.generateSecret());
   * ```
   */
  encrypt(secret: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(CIPHER_ALGORITHM, this.key(), iv);
    const ciphertext = Buffer.concat([
      cipher.update(secret, 'utf8'),
      cipher.final(),
    ]);

    return [
      CIPHERTEXT_FORMAT_VERSION,
      iv.toString('base64url'),
      cipher.getAuthTag().toString('base64url'),
      ciphertext.toString('base64url'),
    ].join(':');
  }

  /**
   * Descifra un secreto guardado. Lo usará la firma de cada entrega.
   *
   * @param encryptedSecret - Valor de `encrypted_secret`.
   * @returns El secreto completo, con `whsec_`.
   *
   * @throws {WebhookSecretEncryptionUnavailableException} Si falta la llave o no mide 32 bytes.
   * @throws {Error} Si el formato no es `v1` o el texto se alteró (falla la autenticación de GCM).
   *
   * @example
   * ```ts
   * cipher.decrypt(cipher.encrypt('whsec_abc')); // 'whsec_abc'
   * ```
   */
  decrypt(encryptedSecret: string): string {
    const [version, iv, authTag, ciphertext] = encryptedSecret.split(':');
    if (
      version !== CIPHERTEXT_FORMAT_VERSION ||
      !iv ||
      !authTag ||
      !ciphertext
    ) {
      throw new Error('Formato de secreto de webhook cifrado desconocido');
    }

    const decipher = createDecipheriv(
      CIPHER_ALGORITHM,
      this.key(),
      Buffer.from(iv, 'base64url'),
    );
    decipher.setAuthTag(Buffer.from(authTag, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertext, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  }

  private key(): Buffer {
    const encoded = process.env[WEBHOOK_SECRET_ENCRYPTION_KEY_ENV];
    const key = encoded ? Buffer.from(encoded, 'base64') : null;
    if (!key || key.length !== KEY_BYTES) {
      this.logger.error(
        `${WEBHOOK_SECRET_ENCRYPTION_KEY_ENV} falta o no son ${KEY_BYTES} bytes en base64: no se pueden cifrar secretos de webhooks.`,
      );
      throw new WebhookSecretEncryptionUnavailableException();
    }
    return key;
  }
}
