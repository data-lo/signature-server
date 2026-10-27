import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, randomBytes } from 'crypto';

import { ApiKeyNotConfiguredException } from './exceptions/api-key.exceptions';

/** Prefijo fijo de toda API key emitida por la plataforma. */
export const API_KEY_TOKEN_PREFIX = 'fma_live';

/** Bytes aleatorios del secreto. El mínimo que exige la historia es 32. */
const SECRET_BYTES = 32;

/** Bytes aleatorios del identificador público (16 caracteres hexadecimales). */
const PUBLIC_ID_BYTES = 8;

/** Largo mínimo del pepper: por debajo, un HMAC filtrado se atacaría por fuerza bruta del pepper. */
const MIN_PEPPER_LENGTH = 32;

/** Lo que se genera al emitir una llave. Sólo `secretHash` se persiste junto a los datos públicos. */
export interface GeneratedApiKeySecret {
  /** Identificador público y único (`api_keys.public_id`). */
  publicId: string;

  /** Prefijo visible, `fma_live_<publicId>` (`api_keys.key_prefix`). */
  keyPrefix: string;

  /** La llave completa en claro, `fma_live_<publicId>_<secret>`. Se entrega una sola vez. */
  key: string;

  /** HMAC-SHA-256 del secreto con `API_KEY_PEPPER`, en hexadecimal (`api_keys.secret_hash`). */
  secretHash: string;
}

/**
 * Genera y protege el secreto de una API key.
 *
 * La llave tiene el formato `fma_live_<publicId>_<secret>`: `publicId` (16 hexadecimales, sin `_`)
 * localiza la fila y `secret` (32 bytes en base64url) es lo único que la autentica. De `secret`
 * sólo se guarda su HMAC-SHA-256 con `API_KEY_PEPPER`, así que una copia de la base no basta para
 * reconstruir ni probar llaves sin el pepper.
 *
 * **Nada de lo que sale de aquí se registra.** Ni el secreto ni la llave completa van a logs,
 * excepciones o auditoría: el único lugar donde viajan es la respuesta de emisión.
 */
@Injectable()
export class ApiKeySecretService {
  private readonly logger = new Logger(ApiKeySecretService.name);

  constructor(private readonly configService: ConfigService) {}

  /**
   * Genera una llave nueva con secreto criptográficamente seguro.
   *
   * @returns El identificador público, el prefijo, la llave completa y el hash del secreto.
   *
   * @throws {ApiKeyNotConfiguredException} (500) Si `API_KEY_PEPPER` falta o es demasiado corto.
   *
   * @example
   * ```ts
   * const { key, keyPrefix, secretHash } = apiKeySecretService.generate();
   * // key: 'fma_live_3f9a0c1b2d4e5f60_Qm9…'
   * ```
   */
  generate(): GeneratedApiKeySecret {
    const publicId = randomBytes(PUBLIC_ID_BYTES).toString('hex');
    const secret = randomBytes(SECRET_BYTES).toString('base64url');
    const keyPrefix = `${API_KEY_TOKEN_PREFIX}_${publicId}`;

    return {
      publicId,
      keyPrefix,
      key: `${keyPrefix}_${secret}`,
      secretHash: this.hashSecret(secret),
    };
  }

  /**
   * HMAC-SHA-256 del secreto con `API_KEY_PEPPER`.
   *
   * @param secret - La parte secreta de la llave, sin prefijo ni `publicId`.
   * @returns El hash en hexadecimal (64 caracteres).
   *
   * @throws {ApiKeyNotConfiguredException} (500) Si `API_KEY_PEPPER` falta o es demasiado corto.
   *
   * @example
   * ```ts
   * apiKeySecretService.hashSecret('Qm9…'); // 'a3f1…' (64 hexadecimales)
   * ```
   */
  hashSecret(secret: string): string {
    return createHmac('sha256', this.getPepper()).update(secret).digest('hex');
  }

  /**
   * Lee el pepper de la configuración.
   *
   * Se valida al usarlo y no al arrancar: un entorno sin la variable sigue sirviendo todo lo
   * demás, y sólo la emisión de llaves falla, con un error que no revela nada al cliente.
   *
   * @returns El valor de `API_KEY_PEPPER`.
   *
   * @throws {ApiKeyNotConfiguredException} (500) Si falta o tiene menos de 32 caracteres.
   *
   * @example
   * ```ts
   * this.getPepper(); // 'valor-largo-y-aleatorio…'
   * ```
   */
  private getPepper(): string {
    const pepper = this.configService.get<string>('API_KEY_PEPPER');

    if (!pepper || pepper.length < MIN_PEPPER_LENGTH) {
      this.logger.error(
        `API_KEY_PEPPER no está configurado o tiene menos de ${MIN_PEPPER_LENGTH} caracteres`,
      );
      throw new ApiKeyNotConfiguredException();
    }

    return pepper;
  }
}
