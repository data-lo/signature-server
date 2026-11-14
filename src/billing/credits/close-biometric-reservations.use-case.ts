import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';

import { CreditReservationEntity } from './credit-reservation.entity';
import { CreditReservationService } from './credit-reservation.service';
import { CREDIT_RESERVATION_STATUS_ENUM } from '../enums/credit-reservation-status.enum';
import { CREDIT_TYPE_ENUM } from '../enums/credit-type.enum';
import { DOCUMENT_CLOSURE_REASON_ENUM } from '../enums/document-closure-reason.enum';

/** Documento que se cierra y por qué. */
export interface CloseBiometricReservationsInput {
  documentId: string;
  closureReason: DOCUMENT_CLOSURE_REASON_ENUM;
}

/** Resultado de un cierre. */
export interface CloseBiometricReservationsResult {
  /** Reservas biométricas que esta llamada consumió; `0` en un reintento. */
  consumed: number;
}

/**
 * Cierra contablemente las reservas biométricas de un documento terminado: las CONSUME, sea cual
 * sea el desenlace (firmado, rechazado, cancelado o vencido).
 *
 * **Regla de negocio**: una firma biométrica queda comprometida desde que se crea el documento.
 * Ningún cierre devuelve créditos biométricos al saldo del cliente.
 *
 * - Cada consumo deja en el ledger un movimiento `CONSUME` con `credit_reservation_id`,
 *   `document_id` y, en `metadata`, `closureReason`, `collaboratorId` y `organizationId`. La
 *   reserva queda con `consumed_at`.
 * - **Idempotente**: sólo se consumen reservas `ACTIVE` (con el `UPDATE` condicionado de
 *   `CreditReservationService`); un segundo cierre del mismo documento no consume nada ni falla.
 * - **Sin Didit**: no abre sesiones ni registra cargos del proveedor. Si el colaborador nunca abrió
 *   su sesión, sólo se consume el crédito comprometido del cliente.
 * - Corre en la transacción del llamador, la misma que cambia el estado del documento.
 */
@Injectable()
export class CloseBiometricReservationsUseCase {
  private readonly logger = new Logger(CloseBiometricReservationsUseCase.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly credits: CreditReservationService,
  ) {}

  /**
   * Ejecuta el caso de uso.
   *
   * @param input - Documento y motivo del cierre.
   * @param manager - Transacción que cambia el estado del documento; sin ella abre una propia.
   * @returns Cuántas reservas consumió esta llamada.
   *
   * @throws {Error} Si un lote no tiene los créditos que la reserva dice haber bloqueado (la
   *   transacción, y con ella el cambio de estado, se deshace).
   *
   * @example
   * ```ts
   * await closeBiometricReservations.execute(
   *   { documentId: 'doc-1', closureReason: DOCUMENT_CLOSURE_REASON_ENUM.DOCUMENT_REJECTED },
   *   manager,
   * ); // { consumed: 3 }
   * ```
   */
  execute(
    input: CloseBiometricReservationsInput,
    manager?: EntityManager,
  ): Promise<CloseBiometricReservationsResult> {
    const run = async (
      tx: EntityManager,
    ): Promise<CloseBiometricReservationsResult> => {
      const active = await tx.getRepository(CreditReservationEntity).find({
        where: {
          documentId: input.documentId,
          creditType: CREDIT_TYPE_ENUM.BIOMETRIC_SIGNATURE,
          status: CREDIT_RESERVATION_STATUS_ENUM.ACTIVE,
        },
        order: { createdAt: 'ASC' },
      });
      if (active.length === 0) {
        return { consumed: 0 };
      }

      const organizationId = await this.findOrganizationId(
        tx,
        input.documentId,
      );

      let consumed = 0;
      for (const reservation of active) {
        const { applied } = await this.credits.consume(
          {
            reservationId: reservation.id,
            metadata: {
              closureReason: input.closureReason,
              documentId: input.documentId,
              creditReservationId: reservation.id,
              organizationId,
            },
          },
          tx,
        );
        if (applied) consumed += 1;
      }

      this.logger.log(
        `Documento ${input.documentId} cerrado (${input.closureReason}): ${consumed} reserva(s) biométrica(s) consumida(s).`,
      );
      return { consumed };
    };

    return manager ? run(manager) : this.dataSource.transaction(run);
  }

  /**
   * Organización del documento, para el ledger.
   *
   * @param tx - Transacción.
   * @param documentId - Documento.
   * @returns El `organization_id`, o `null` en documentos de cuenta personal.
   *
   * @example
   * ```ts
   * await this.findOrganizationId(tx, 'doc-1'); // 'org-1'
   * ```
   */
  private async findOrganizationId(
    tx: EntityManager,
    documentId: string,
  ): Promise<string | null> {
    const [row] = (await tx.query(
      `SELECT "organization_id" FROM "documents" WHERE "id" = $1`,
      [documentId],
    )) as { organization_id: string | null }[];
    return row?.organization_id ?? null;
  }
}
