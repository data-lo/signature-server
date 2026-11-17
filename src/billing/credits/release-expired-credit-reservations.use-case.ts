import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { CloseBiometricReservationsUseCase } from './close-biometric-reservations.use-case';
import { CreditReservationService } from './credit-reservation.service';
import { DOCUMENT_CLOSURE_REASON_ENUM } from '../enums/document-closure-reason.enum';

/** Cuántas reservas se liberan por pasada; el resto queda para la siguiente. */
const DEFAULT_BATCH_SIZE = 200;

/** Resultado de una pasada. */
export interface ReleaseExpiredCreditReservationsResult {
  /** Reservas vencidas que esta pasada liberó (estado `EXPIRED`). */
  expired: number;
  /** Reservas documentales de documentos ya cerrados que esta pasada liberó (estado `RELEASED`). */
  orphaned: number;
  /** Reservas biométricas de documentos ya cerrados que esta pasada consumió (estado `CONSUMED`). */
  consumed: number;
  /** Reservas que no se pudieron liberar; se reintentan en la siguiente pasada. */
  failed: number;
}

/** Motivo de cierre según el estado terminal del documento. */
const CLOSURE_REASON_BY_STATUS: Record<string, DOCUMENT_CLOSURE_REASON_ENUM> = {
  SIGNED: DOCUMENT_CLOSURE_REASON_ENUM.DOCUMENT_SIGNED,
  REJECTED: DOCUMENT_CLOSURE_REASON_ENUM.DOCUMENT_REJECTED,
  CANCELLED: DOCUMENT_CLOSURE_REASON_ENUM.DOCUMENT_CANCELLED,
  EXPIRED: DOCUMENT_CLOSURE_REASON_ENUM.DOCUMENT_EXPIRED,
};

/**
 * Red de seguridad de las reservas: resuelve las que ningún cierre resolvió.
 *
 * Tres barridos:
 * 1. **Vencidas**: documentales `ACTIVE` con `expires_at` pasado; quedan en `EXPIRED`. Las
 *    biométricas nunca se liberan (ver `CloseBiometricReservationsUseCase`), así que este barrido
 *    no las toca aunque tengan un `expires_at` de antes.
 * 2. **Documentales de documentos cerrados** (`REJECTED`, `CANCELLED` o `EXPIRED`): se liberan y
 *    quedan en `RELEASED`.
 * 3. **Biométricas de documentos cerrados** (los mismos más `SIGNED`): se CONSUMEN con el motivo
 *    del estado del documento. Cubre un cierre que no alcanzó a resolverlas, p. ej. un documento
 *    que se marcó vencido fuera de la aplicación.
 *
 * **Idempotente**: cada reserva se libera con el `UPDATE` condicionado del servicio, en su propia
 * transacción; si dos instancias corren a la vez, la segunda encuentra la reserva ya resuelta. Un
 * fallo en una no detiene las demás.
 *
 * Lo ejecuta `ReleaseExpiredCreditReservationsJob` cada cinco minutos.
 */
@Injectable()
export class ReleaseExpiredCreditReservationsUseCase {
  private readonly logger = new Logger(
    ReleaseExpiredCreditReservationsUseCase.name,
  );

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly credits: CreditReservationService,
    private readonly closeBiometricReservations: CloseBiometricReservationsUseCase,
  ) {}

  /**
   * Ejecuta una pasada.
   *
   * @param options.now - Instante de referencia; por defecto, el actual.
   * @param options.batchSize - Máximo de reservas por barrido.
   * @returns Cuántas liberó y cuántas fallaron.
   *
   * @throws {QueryFailedError} Si falla la búsqueda de candidatas (no las liberaciones, que se
   *   registran y se cuentan).
   *
   * @example
   * ```ts
   * await releaseExpired.execute(); // { expired: 0, orphaned: 1, consumed: 3, failed: 0 }
   * ```
   */
  async execute(
    options: { now?: Date; batchSize?: number } = {},
  ): Promise<ReleaseExpiredCreditReservationsResult> {
    const now = options.now ?? new Date();
    const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
    const result: ReleaseExpiredCreditReservationsResult = {
      expired: 0,
      orphaned: 0,
      consumed: 0,
      failed: 0,
    };

    const expired = await this.dataSource.query<{ id: string }[]>(
      `SELECT r."id"
         FROM "credit_reservations" r
        WHERE r."status" = 'ACTIVE'
          AND r."credit_type" <> 'BIOMETRIC_SIGNATURE'
          AND r."expires_at" IS NOT NULL
          AND r."expires_at" <= $1
        ORDER BY r."expires_at"
        LIMIT $2`,
      [now, batchSize],
    );
    for (const { id } of expired) {
      await this.releaseOne(id, 'RESERVATION_EXPIRED', true, result, 'expired');
    }

    const orphaned = await this.dataSource.query<{ id: string }[]>(
      `SELECT r."id"
         FROM "credit_reservations" r
         JOIN "documents" d ON d."id" = r."document_id"
        WHERE r."status" = 'ACTIVE'
          AND r."credit_type" = 'DOCUMENT_SIGNATURE'
          AND d."status" IN ('REJECTED', 'CANCELLED', 'EXPIRED')
        ORDER BY r."created_at"
        LIMIT $1`,
      [batchSize],
    );
    for (const { id } of orphaned) {
      await this.releaseOne(id, 'DOCUMENT_CLOSED', false, result, 'orphaned');
    }

    const closedBiometric = await this.dataSource.query<
      { document_id: string; status: string }[]
    >(
      `SELECT DISTINCT r."document_id", d."status"
         FROM "credit_reservations" r
         JOIN "documents" d ON d."id" = r."document_id"
        WHERE r."status" = 'ACTIVE'
          AND r."credit_type" = 'BIOMETRIC_SIGNATURE'
          AND d."status" IN ('SIGNED', 'REJECTED', 'CANCELLED', 'EXPIRED')
        LIMIT $1`,
      [batchSize],
    );
    for (const { document_id: documentId, status } of closedBiometric) {
      await this.consumeClosed(
        documentId,
        CLOSURE_REASON_BY_STATUS[status],
        result,
      );
    }

    if (result.expired || result.orphaned || result.consumed || result.failed) {
      this.logger.log(
        `Reservas resueltas: ${result.expired} vencida(s), ${result.orphaned} documental(es) liberada(s) y ${result.consumed} biométrica(s) consumida(s) de documentos cerrados, ${result.failed} con error.`,
      );
    }

    return result;
  }

  /**
   * Consume las biométricas de un documento cerrado y las cuenta, sin dejar que su fallo detenga
   * la pasada.
   *
   * @param documentId - Documento cerrado.
   * @param closureReason - Motivo según su estado.
   * @param result - Acumulador de la pasada.
   * @returns Nada.
   *
   * @example
   * ```ts
   * await this.consumeClosed('doc-1', DOCUMENT_CLOSURE_REASON_ENUM.DOCUMENT_EXPIRED, result);
   * ```
   */
  private async consumeClosed(
    documentId: string,
    closureReason: DOCUMENT_CLOSURE_REASON_ENUM,
    result: ReleaseExpiredCreditReservationsResult,
  ): Promise<void> {
    try {
      const { consumed } = await this.closeBiometricReservations.execute({
        documentId,
        closureReason,
      });
      result.consumed += consumed;
    } catch (error) {
      result.failed += 1;
      this.logger.error(
        `No se pudieron consumir las reservas biométricas del documento cerrado ${documentId}.`,
        error instanceof Error ? error.stack : undefined,
      );
    }
  }

  /**
   * Libera una reserva y la cuenta, sin dejar que su fallo detenga la pasada.
   *
   * @param reservationId - Reserva.
   * @param reason - Motivo para el ledger.
   * @param expired - Si queda en `EXPIRED` (o en `RELEASED`).
   * @param result - Acumulador de la pasada.
   * @param counter - Contador que sube si esta llamada la liberó.
   * @returns Nada.
   *
   * @example
   * ```ts
   * await this.releaseOne('res-1', 'RESERVATION_EXPIRED', true, result, 'expired');
   * ```
   */
  private async releaseOne(
    reservationId: string,
    reason: string,
    expired: boolean,
    result: ReleaseExpiredCreditReservationsResult,
    counter: 'expired' | 'orphaned',
  ): Promise<void> {
    try {
      const { applied } = await this.credits.release({
        reservationId,
        reason,
        expired,
      });
      if (applied) result[counter] += 1;
    } catch (error) {
      result.failed += 1;
      this.logger.error(
        `No se pudo liberar la reserva ${reservationId}.`,
        error instanceof Error ? error.stack : undefined,
      );
    }
  }
}
