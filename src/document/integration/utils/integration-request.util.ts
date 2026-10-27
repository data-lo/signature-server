import { createHash } from 'crypto';

import {
  IdempotencyKeyRequiredException,
  TenantOverrideNotAllowedException,
} from '../exceptions/integration-document.exceptions';

/** Campos con los que un cliente intentaría elegir el tenant o el autor. */
export const TENANT_OVERRIDE_FIELDS = [
  'organizationId',
  'taxId',
  'accountId',
  'createdBy',
  'createdByUserId',
] as const;

/** Headers de cuenta activa de la plataforma, que esta API no usa. */
export const TENANT_OVERRIDE_HEADERS = ['x-account-id', 'x-organization-id'];

/** 1 a 255 caracteres ASCII visibles (sin espacios ni controles). */
const IDEMPOTENCY_KEY_PATTERN = /^[\x21-\x7e]{1,255}$/;

/** Lo que se revisa de la petición: crudo, antes de que el `ValidationPipe` lo recorte. */
export interface IntegrationRawRequest {
  headers?: Record<string, unknown>;
  query?: Record<string, unknown>;
  body?: Record<string, unknown>;
}

/**
 * Rechaza la petición si intenta elegir organización, cuenta o autor.
 *
 * Se revisa la petición CRUDA porque el `ValidationPipe` global (`whitelist`) descartaría esos
 * campos en silencio, y un cliente que los manda tiene que enterarse de que no sirven. Se mira el
 * query, los headers de cuenta activa, el primer nivel del body y `documentData` (que en multipart
 * llega como JSON en texto). `collaborators` no: el `taxId` de un testigo es un dato legítimo.
 *
 * @param request - Headers, query y body tal como llegaron.
 * @returns Nada.
 *
 * @throws {TenantOverrideNotAllowedException} (400) Si aparece alguno de esos campos o headers.
 *
 * @example
 * ```ts
 * assertNoTenantOverrides({ query: { organizationId: 'org-2' } }); // lanza 400
 * ```
 */
export function assertNoTenantOverrides(request: IntegrationRawRequest): void {
  const found = new Set<string>();

  for (const header of TENANT_OVERRIDE_HEADERS) {
    if (request.headers?.[header] !== undefined) found.add(header);
  }

  const containers = [
    request.query,
    request.body,
    parseJsonObject(request.body?.documentData),
  ];
  for (const container of containers) {
    for (const field of TENANT_OVERRIDE_FIELDS) {
      if (container && Object.prototype.hasOwnProperty.call(container, field)) {
        found.add(field);
      }
    }
  }

  if (found.size > 0) {
    throw new TenantOverrideNotAllowedException([...found]);
  }
}

/**
 * Lee y valida el header `Idempotency-Key`.
 *
 * @param header - Valor crudo del header.
 * @returns La clave, sin espacios alrededor.
 *
 * @throws {IdempotencyKeyRequiredException} (400) Si falta o no tiene de 1 a 255 caracteres ASCII
 *   visibles.
 *
 * @example
 * ```ts
 * readIdempotencyKey('erp-pedido-8841'); // 'erp-pedido-8841'
 * ```
 */
export function readIdempotencyKey(header: unknown): string {
  const value = typeof header === 'string' ? header.trim() : '';

  if (!IDEMPOTENCY_KEY_PATTERN.test(value)) {
    throw new IdempotencyKeyRequiredException();
  }

  return value;
}

/**
 * Huella de una petición de creación: SHA-256 del archivo y de los campos multipart tal como
 * llegaron. Un reintento legítimo manda exactamente lo mismo y produce la misma huella.
 *
 * @param file - PDF recibido; sin archivo cuenta como vacío.
 * @param body - Body crudo del multipart.
 * @returns La huella en hexadecimal (64 caracteres).
 *
 * @example
 * ```ts
 * buildRequestFingerprint(file, request.body); // 'c0ffee…'
 * ```
 */
export function buildRequestFingerprint(
  file: Pick<Express.Multer.File, 'buffer'> | undefined,
  body: Record<string, unknown> | undefined,
): string {
  const fileHash = createHash('sha256')
    .update(file?.buffer ?? Buffer.alloc(0))
    .digest('hex');

  return createHash('sha256')
    .update(
      JSON.stringify([
        fileHash,
        body?.documentData ?? null,
        body?.collaborators ?? null,
        body?.requiresDifferentSignatures ?? null,
      ]),
    )
    .digest('hex');
}

function parseJsonObject(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object') {
    return value as Record<string, unknown>;
  }
  if (typeof value !== 'string') return null;

  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}
