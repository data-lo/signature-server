import { EntityManager } from 'typeorm';

import { CreditLedgerEntryEntity } from './credit-ledger-entry.entity';
import { CreditLotEntity } from './credit-lot.entity';
import { CREDIT_LEDGER_MOVEMENT_TYPE_ENUM } from '../enums/credit-ledger-movement-type.enum';
import { CREDIT_TYPE_ENUM } from '../enums/credit-type.enum';

/** Un movimiento por registrar en `credit_ledger_entries`. */
export interface CreditLedgerEntryInput {
  billingProfileId: string;
  creditLotId: string | null;
  creditType: CREDIT_TYPE_ENUM;
  movementType: CREDIT_LEDGER_MOVEMENT_TYPE_ENUM;
  quantity: number;
  idempotencyKey: string;
  creditReservationId?: string | null;
  documentId?: string | null;
  biometricSignatureAttemptId?: string | null;
  stripePaymentIntentId?: string | null;
  metadata?: Record<string, unknown> | null;
}

/**
 * Clave del movimiento que acredita un lote. Una por lote: emitirlo dos veces es imposible por el
 * índice único de la clave.
 *
 * @param creditLotId - Lote emitido.
 * @returns La clave `issue:lot:<id>`.
 *
 * @example
 * ```ts
 * lotIssuedLedgerKey('lote-1'); // 'issue:lot:lote-1'
 * ```
 */
export function lotIssuedLedgerKey(creditLotId: string): string {
  return `issue:lot:${creditLotId}`;
}

/**
 * Clave del consumo del crédito documental de un documento. La comparten el consumo inmediato y el
 * de una reserva documental, así que un documento no puede pagarse dos veces por ningún camino.
 *
 * @param documentId - Documento cobrado.
 * @returns La clave `consume:document:<id>`.
 *
 * @example
 * ```ts
 * documentConsumptionLedgerKey('doc-1'); // 'consume:document:doc-1'
 * ```
 */
export function documentConsumptionLedgerKey(documentId: string): string {
  return `consume:document:${documentId}`;
}

/**
 * Registra un movimiento en el ledger, dentro de la transacción del cambio que describe.
 *
 * Si la clave de idempotencia ya existe no escribe nada y devuelve `false`: el hecho ya estaba
 * registrado. Quien cambió el saldo decide si eso es un reintento legítimo o una inconsistencia.
 *
 * @param manager - Transacción en curso; la misma que tocó `credit_lots`.
 * @param entry - Movimiento a registrar.
 * @returns `true` si se insertó; `false` si la clave ya estaba.
 *
 * @throws {QueryFailedError} Si viola otra restricción (cantidad no positiva, lote de otro perfil
 *   o de otro tipo).
 *
 * @example
 * ```ts
 * await recordCreditLedgerEntry(manager, {
 *   billingProfileId: 'bp-1',
 *   creditLotId: 'lote-1',
 *   creditType: CREDIT_TYPE_ENUM.DOCUMENT_SIGNATURE,
 *   movementType: CREDIT_LEDGER_MOVEMENT_TYPE_ENUM.CONSUME,
 *   quantity: 1,
 *   idempotencyKey: documentConsumptionLedgerKey('doc-1'),
 *   documentId: 'doc-1',
 * }); // true
 * ```
 */
export async function recordCreditLedgerEntry(
  manager: EntityManager,
  entry: CreditLedgerEntryInput,
): Promise<boolean> {
  const result = await manager
    .createQueryBuilder()
    .insert()
    .into(CreditLedgerEntryEntity)
    .values({
      billingProfileId: entry.billingProfileId,
      creditLotId: entry.creditLotId,
      creditType: entry.creditType,
      movementType: entry.movementType,
      quantity: entry.quantity,
      idempotencyKey: entry.idempotencyKey,
      creditReservationId: entry.creditReservationId ?? null,
      documentId: entry.documentId ?? null,
      biometricSignatureAttemptId: entry.biometricSignatureAttemptId ?? null,
      stripePaymentIntentId: entry.stripePaymentIntentId ?? null,
      metadata: entry.metadata ?? null,
    })
    .orIgnore()
    .returning(['id'])
    .execute();

  // Con `ON CONFLICT DO NOTHING`, Postgres no devuelve fila cuando la clave ya existía.
  return Array.isArray(result.raw) && result.raw.length > 0;
}

/**
 * Registra la acreditación de un lote recién emitido (`PURCHASE` o `GRANT`, por `issued`).
 *
 * Idempotente por lote: llamarlo sobre un lote reutilizado (una reentrega de Stripe que encontró
 * el lote ya emitido) no duplica el movimiento.
 *
 * @param manager - Transacción que emitió el lote.
 * @param lot - Lote emitido, con `id`, perfil, tipo e `issued`.
 * @param movementType - `PURCHASE` si hubo cobro; `GRANT` si no.
 * @param metadata - Contexto adicional (origen, factura…).
 * @returns `true` si se insertó el movimiento.
 *
 * @throws {QueryFailedError} Si el lote no existe en la transacción.
 *
 * @example
 * ```ts
 * await recordLotIssued(manager, lot, CREDIT_LEDGER_MOVEMENT_TYPE_ENUM.PURCHASE, { origin: lot.origin });
 * ```
 */
export function recordLotIssued(
  manager: EntityManager,
  lot: Pick<
    CreditLotEntity,
    | 'id'
    | 'billingProfileId'
    | 'creditType'
    | 'issued'
    | 'origin'
    | 'stripePaymentIntentId'
  >,
  movementType:
    | CREDIT_LEDGER_MOVEMENT_TYPE_ENUM.PURCHASE
    | CREDIT_LEDGER_MOVEMENT_TYPE_ENUM.GRANT,
  metadata: Record<string, unknown> = {},
): Promise<boolean> {
  return recordCreditLedgerEntry(manager, {
    billingProfileId: lot.billingProfileId,
    creditLotId: lot.id,
    creditType: lot.creditType ?? CREDIT_TYPE_ENUM.DOCUMENT_SIGNATURE,
    movementType,
    quantity: lot.issued,
    idempotencyKey: lotIssuedLedgerKey(lot.id),
    stripePaymentIntentId: lot.stripePaymentIntentId ?? null,
    metadata: { origin: lot.origin, ...metadata },
  });
}
