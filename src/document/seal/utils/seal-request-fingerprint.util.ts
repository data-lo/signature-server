import { createHash } from 'crypto';

import type { SealDocumentDto } from '../dto/seal-document.dto';
import type { SimpleSignatureDTO } from '../dto/simple-signature.dto';

/** Versión del formato de la clave; súbela sólo si cambia lo que identifica a una operación. */
export const SEAL_IDEMPOTENCY_KEY_VERSION = 'v1';

/** Payload normalizado de un sellado y lo que lo identifica ante Seal Service. */
export interface SealRequestFingerprint<T> {
  /** `Idempotency-Key` estable del documento. */
  idempotencyKey: string;
  /** Payload con las firmas en orden estable; es lo que se envía. */
  payload: T;
  /** SHA-256 en hexadecimal de la serialización canónica de `payload`. */
  requestHash: string;
}

/**
 * Clave de idempotencia de un documento ante Seal Service. Es la misma en todas las ejecuciones
 * del sellado de ese documento, sea firma simple o avanzada: un documento se sella una sola vez.
 *
 * @param documentId - Documento.
 * @returns `signature-server:document:<documentId>:v1`.
 *
 * @example
 * ```ts
 * buildSealIdempotencyKey('2be3b9d7-…'); // 'signature-server:document:2be3b9d7-…:v1'
 * ```
 */
export function buildSealIdempotencyKey(documentId: string): string {
  return `signature-server:document:${documentId}:${SEAL_IDEMPOTENCY_KEY_VERSION}`;
}

/**
 * Normaliza el payload de firma avanzada: firmas ordenadas por RFC, fecha de firma y firma, el
 * mismo criterio con el que Seal Service arma su cadena canónica. Las fechas ya llegan en ISO 8601
 * (ver `toSealSignature`).
 *
 * @param dto - Payload de `POST /seal/signature`.
 * @returns Clave, payload normalizado y su hash.
 *
 * @example
 * ```ts
 * const { idempotencyKey, payload, requestHash } = fingerprintAdvancedSealRequest(dto);
 * ```
 */
export function fingerprintAdvancedSealRequest(
  dto: SealDocumentDto,
): SealRequestFingerprint<SealDocumentDto> {
  const payload: SealDocumentDto = {
    ...dto,
    signatures: [...dto.signatures].sort(
      (a, b) =>
        compare(a.certificate.rfc, b.certificate.rfc) ||
        compare(a.signedAt, b.signedAt) ||
        compare(a.signatureBase64, b.signatureBase64),
    ),
  };
  return fingerprint(dto.documentId, payload);
}

/**
 * Normaliza el payload de firma simple: firmas ordenadas por CURP y fecha de firma, como en Seal
 * Service.
 *
 * @param dto - Payload de `POST /seal/simple-signature`.
 * @returns Clave, payload normalizado y su hash.
 *
 * @example
 * ```ts
 * const { idempotencyKey, payload } = fingerprintSimpleSealRequest(dto);
 * ```
 */
export function fingerprintSimpleSealRequest(
  dto: SimpleSignatureDTO,
): SealRequestFingerprint<SimpleSignatureDTO> {
  const payload: SimpleSignatureDTO = {
    ...dto,
    signatures: [...dto.signatures].sort(
      (a, b) => compare(a.curp, b.curp) || compare(a.signedAt, b.signedAt),
    ),
  };
  return fingerprint(dto.documentId, payload);
}

/**
 * Serializa un valor JSON con las llaves de cada objeto ordenadas, para que dos payloads
 * equivalentes produzcan exactamente el mismo texto. Omite las propiedades `undefined`, igual que
 * `JSON.stringify`.
 *
 * @param value - Valor serializable.
 * @returns El JSON canónico.
 *
 * @example
 * ```ts
 * canonicalJson({ b: 1, a: [2, { d: 3, c: 4 }] }); // '{"a":[2,{"c":4,"d":3}],"b":1}'
 * ```
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item ?? null)).join(',')}]`;
  }
  if (value instanceof Date) {
    return JSON.stringify(value.toISOString());
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([a], [b]) => compare(a, b))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

function fingerprint<T>(
  documentId: string,
  payload: T,
): SealRequestFingerprint<T> {
  return {
    idempotencyKey: buildSealIdempotencyKey(documentId),
    payload,
    requestHash: createHash('sha256')
      .update(canonicalJson(payload), 'utf8')
      .digest('hex'),
  };
}

/** Comparación por código de unidad, independiente del locale del proceso. */
function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
