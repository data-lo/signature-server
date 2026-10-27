import {
  BadRequestException,
  ConflictException,
  Injectable,
  UnprocessableEntityException,
} from '@nestjs/common';
import { createHash } from 'crypto';

import { RedisService } from 'src/common/redis/redis.service';

/** Cuánto se recuerda una clave: lo bastante para cubrir reintentos de red de una firma. */
export const SIGNING_IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60;

/** Cuánto puede tardar una firma en curso antes de que su clave se pueda volver a usar. */
export const SIGNING_IDEMPOTENCY_LEASE_SECONDS = 10 * 60;

/** 1 a 255 caracteres ASCII visibles, igual que en la API de integración. */
const IDEMPOTENCY_KEY_PATTERN = /^[\x21-\x7e]{1,255}$/;

/** Estado guardado de una clave. */
type StoredIdempotency =
  | { state: 'PROCESSING'; requestHash: string }
  | { state: 'COMPLETED'; requestHash: string; response: unknown };

/**
 * Valida el header `Idempotency-Key` de una operación que completa una firma.
 *
 * @param header - Valor del header.
 * @returns La clave.
 *
 * @throws {BadRequestException} Si falta o no tiene el formato.
 *
 * @example
 * ```ts
 * const key = requireSigningIdempotencyKey(headers['idempotency-key']);
 * ```
 */
export function requireSigningIdempotencyKey(
  header: string | undefined,
): string {
  if (!header || !IDEMPOTENCY_KEY_PATTERN.test(header)) {
    throw new BadRequestException(
      'El header Idempotency-Key es obligatorio para firmar (1 a 255 caracteres ASCII visibles).',
    );
  }
  return header;
}

/**
 * Huella de una petición de firma: operación, campos (sin la contraseña) y el SHA-256 de cada
 * archivo. Dos envíos de la misma firma dan la misma huella; cambiar cualquier dato, otra.
 *
 * @param operation - Ruta lógica (`simple`, `advanced`, `biometric`).
 * @param fields - Campos del cuerpo; la contraseña se excluye antes de llamar.
 * @param files - Archivos subidos.
 * @returns SHA-256 hex.
 *
 * @throws Nada.
 *
 * @example
 * ```ts
 * signingRequestFingerprint('simple', { documentHash, geolocation }, [png]);
 * ```
 */
export function signingRequestFingerprint(
  operation: string,
  fields: Record<string, unknown>,
  files: (Express.Multer.File | undefined)[] = [],
): string {
  const fileHashes = files.map((file) =>
    file ? createHash('sha256').update(file.buffer).digest('hex') : null,
  );
  return createHash('sha256')
    .update(JSON.stringify({ operation, fields, fileHashes }))
    .digest('hex');
}

/**
 * Idempotencia de las operaciones que completan una firma pública.
 *
 * La firma ya es idempotente en el fondo —el claim `PENDING → SIGNED` es condicional—, pero sin
 * esto un reintento de red recibiría "ya respondiste" en vez de la respuesta de la firma que sí se
 * registró. Con la misma clave y la misma petición se devuelve la respuesta guardada; con la misma
 * clave y otra petición, 422; mientras la primera sigue en curso, 409.
 *
 * Las claves se guardan por colaborador y hasheadas: la clave del cliente no aparece en Redis.
 */
@Injectable()
export class SigningIdempotencyService {
  constructor(private readonly redis: RedisService) {}

  /**
   * Ejecuta una operación una sola vez por clave.
   *
   * @param scope - Colaborador que firma (las claves de dos firmantes nunca chocan).
   * @param idempotencyKey - Clave del header.
   * @param requestHash - Huella de la petición (`signingRequestFingerprint`).
   * @param operation - La firma.
   * @returns La respuesta de la operación, o la guardada si es un reintento.
   *
   * @throws {ConflictException} (409) Si la misma clave sigue en curso.
   * @throws {UnprocessableEntityException} (422) Si la clave se usó con otra petición.
   * @throws Lo que lance la operación; en ese caso la clave se libera para reintentar.
   *
   * @example
   * ```ts
   * await idempotency.run('c-1', key, hash, () => signDocument.sign(actor, command));
   * ```
   */
  async run<T>(
    scope: string,
    idempotencyKey: string,
    requestHash: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const key = this.key(scope, idempotencyKey);
    const reserved = await this.redis.setIfAbsent(
      key,
      JSON.stringify({
        state: 'PROCESSING',
        requestHash,
      } satisfies StoredIdempotency),
      SIGNING_IDEMPOTENCY_LEASE_SECONDS,
    );

    if (!reserved) {
      const stored = JSON.parse(
        (await this.redis.get(key)) ?? 'null',
      ) as StoredIdempotency | null;
      if (!stored) {
        // Venció entre las dos lecturas: se trata como en curso; el cliente reintenta.
        throw new ConflictException('La firma con esta clave está en curso.');
      }
      if (stored.requestHash !== requestHash) {
        throw new UnprocessableEntityException(
          'El Idempotency-Key ya se usó con otra petición de firma.',
        );
      }
      if (stored.state === 'PROCESSING') {
        throw new ConflictException('La firma con esta clave está en curso.');
      }
      return stored.response as T;
    }

    try {
      const response = await operation();
      await this.redis.set(
        key,
        JSON.stringify({
          state: 'COMPLETED',
          requestHash,
          response,
        } satisfies StoredIdempotency),
        SIGNING_IDEMPOTENCY_TTL_SECONDS,
      );
      return response;
    } catch (error) {
      await this.redis.del(key).catch(() => undefined);
      throw error;
    }
  }

  private key(scope: string, idempotencyKey: string): string {
    const hashed = createHash('sha256').update(idempotencyKey).digest('hex');
    return `signing-idempotency:${scope}:${hashed}`;
  }
}
