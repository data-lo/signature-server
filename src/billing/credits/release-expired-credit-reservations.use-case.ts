import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { CreditReservationService } from './credit-reservation.service';

/** Cuántas reservas se liberan por pasada; el resto queda para la siguiente. */
const DEFAULT_BATCH_SIZE = 200;

/** Resultado de una pasada. */
export interface ReleaseExpiredCreditReservationsResult {
  /** Reservas vencidas que esta pasada liberó (estado `EXPIRED`). */
  expired: number;
  /** Reservas de documentos ya cerrados que esta pasada liberó (estado `RELEASED`). */
  orphaned: number;
  /** Reservas que no se pudieron liberar; se reintentan en la siguiente pasada. */
  failed: number;
}

/**
 * Red de seguridad de las reservas: devuelve al saldo las que nadie resolvió.
 *
 * Dos barridos:
 * 1. **Vencidas**: `ACTIVE` con `expires_at` pasado. Una biométrica cuyo intento sigue abierto
 *    (`PENDING`, `IN_PROGRESS`) o aprobado (`APPROVED`) NO se libera aunque haya vencido: su
 *    webhook todavía puede cobrarla, y liberarla dejaría una firma registrada sin pagar. Quedan en
 *    estado `EXPIRED`.
 * 2. **De documentos cerrados**: `ACTIVE` de un documento `REJECTED`, `CANCELLED` o `EXPIRED`. Cubre
 *    el caso en que el cierre del documento no alcanzó a liberarlas. Quedan en `RELEASED`.
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
   * await releaseExpired.execute(); // { expired: 3, orphaned: 0, failed: 0 }
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
      failed: 0,
    };

    const expired = await this.dataSource.query<{ id: string }[]>(
      `SELECT r."id"
         FROM "credit_reservations" r
        WHERE r."status" = 'ACTIVE'
          AND r."expires_at" IS NOT NULL
          AND r."expires_at" <= $1
          AND NOT EXISTS (
            SELECT 1 FROM "biometric_signature_attempts" a
             WHERE a."id" = r."biometric_signature_attempt_id"
               AND a."status" IN ('PENDING', 'IN_PROGRESS', 'APPROVED')
          )
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
          AND d."status" IN ('REJECTED', 'CANCELLED', 'EXPIRED')
        ORDER BY r."created_at"
        LIMIT $1`,
      [batchSize],
    );
    for (const { id } of orphaned) {
      await this.releaseOne(id, 'DOCUMENT_CLOSED', false, result, 'orphaned');
    }

    if (result.expired || result.orphaned || result.failed) {
      this.logger.log(
        `Reservas liberadas: ${result.expired} vencida(s), ${result.orphaned} de documentos cerrados, ${result.failed} con error.`,
      );
    }

    return result;
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
