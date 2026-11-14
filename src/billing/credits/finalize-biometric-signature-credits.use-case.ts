import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';

import { CloseBiometricReservationsUseCase } from './close-biometric-reservations.use-case';
import { documentConsumptionLedgerKey } from './credit-ledger.util';
import { CreditReservationEntity } from './credit-reservation.entity';
import { CreditReservationService } from './credit-reservation.service';
import { DocumentCreditConsumptionEntity } from './document-credit-consumption.entity';
import { BILLING_SIGNATURE_TYPE_ENUM } from '../enums/billing-signature-type.enum';
import { CREDIT_RESERVATION_STATUS_ENUM } from '../enums/credit-reservation-status.enum';
import { CREDIT_TYPE_ENUM } from '../enums/credit-type.enum';
import { DOCUMENT_CLOSURE_REASON_ENUM } from '../enums/document-closure-reason.enum';

/** Firma biométrica registrada: qué se cobra. */
export interface BiometricSignatureSucceededInput {
  biometricSignatureAttemptId: string;
  documentId: string;
  /** `true` si esta firma completó el documento (`SignedDocumentData.documentCompleted`). */
  documentCompleted: boolean;
}

/** Lo que se cobró en una firma exitosa. */
export interface BiometricSignatureSettlement {
  /** `true` si esta llamada consumió el crédito biométrico del intento. */
  biometricConsumed: boolean;
  /** `true` si esta llamada consumió el crédito documental del documento. */
  documentConsumed: boolean;
}

/**
 * Cierra las reservas de créditos de la firma biométrica según su desenlace.
 *
 * - **Firma registrada** (`onSignatureSucceeded`): consume el crédito biométrico del intento y, si
 *   esa firma completó el documento, también el documental, dejando el recibo en
 *   `document_credit_consumptions`. Todo en una transacción.
 * - **Intento fallido** (`onAttemptFailed`): Didit rechazó, venció o falló, o el intento se cerró
 *   sin firmar. NO libera nada: el crédito biométrico está comprometido con el colaborador desde la
 *   creación del documento, y su siguiente intento se asocia a la misma reserva.
 * - **Documento cerrado sin completarse** (`onDocumentClosed`): rechazado o cancelado; libera el
 *   crédito documental y CONSUME los biométricos (`CloseBiometricReservationsUseCase`).
 *
 * **Idempotente ante reintentos del webhook**: cada reserva sólo se resuelve una vez (ver
 * `CreditReservationService`), así que una segunda entrega no cobra ni devuelve de nuevo.
 */
@Injectable()
export class FinalizeBiometricSignatureCreditsUseCase {
  private readonly logger = new Logger(
    FinalizeBiometricSignatureCreditsUseCase.name,
  );

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly credits: CreditReservationService,
    private readonly closeBiometricReservations: CloseBiometricReservationsUseCase,
  ) {}

  /**
   * Cobra la firma biométrica registrada y, si completó el documento, el crédito documental.
   *
   * @param input - Intento, documento y si quedó completo.
   * @returns Qué se consumió en esta llamada; en un reintento, nada.
   *
   * @throws {Error} Si un lote no cuadra con su reserva (la transacción se deshace y el webhook se
   *   reintenta).
   *
   * @example
   * ```ts
   * await finalize.onSignatureSucceeded({ biometricSignatureAttemptId: 'att-1', documentId: 'doc-1', documentCompleted: true });
   * ```
   */
  onSignatureSucceeded(
    input: BiometricSignatureSucceededInput,
  ): Promise<BiometricSignatureSettlement> {
    return this.dataSource.transaction(async (tx) => {
      const biometricConsumed = await this.consumeBiometric(tx, input);
      const documentConsumed = input.documentCompleted
        ? await this.consumeDocument(tx, input.documentId)
        : false;

      return { biometricConsumed, documentConsumed };
    });
  }

  /**
   * Registra que un intento terminó sin firma. No libera el crédito biométrico: está comprometido
   * con el colaborador desde que se creó el documento, la reserva sigue `ACTIVE` y el siguiente
   * intento del colaborador se asocia a ella (ver `ReserveBiometricSignatureCreditsUseCase`). La
   * cierra el cierre del documento.
   *
   * @param input.biometricSignatureAttemptId - Intento.
   * @param input.reason - Motivo (p. ej. `DIDIT_DECLINED`), sólo para el log.
   * @returns Siempre `false`: ninguna reserva cambia.
   *
   * @example
   * ```ts
   * await finalize.onAttemptFailed({ biometricSignatureAttemptId: 'att-1', reason: 'DIDIT_DECLINED' }); // false
   * ```
   */
  async onAttemptFailed(input: {
    biometricSignatureAttemptId: string;
    reason: string;
  }): Promise<boolean> {
    const reservation = await this.credits.findByAttempt(
      input.biometricSignatureAttemptId,
    );
    if (reservation?.status === CREDIT_RESERVATION_STATUS_ENUM.ACTIVE) {
      this.logger.log(
        `Intento ${input.biometricSignatureAttemptId} terminó sin firma (${input.reason}): la reserva ${reservation.id} sigue comprometida con el colaborador ${reservation.collaboratorId}.`,
      );
    }
    return false;
  }

  /**
   * Cierra las reservas de un documento que ya no va a completarse: libera la documental y consume
   * las biométricas, que no se reembolsan.
   *
   * @param input.documentId - Documento rechazado, cancelado o vencido.
   * @param input.closureReason - Motivo del cierre; queda en el ledger.
   * @param manager - Transacción que cambia el estado del documento; sin ella abre una propia.
   * @returns Cuántas reservas resolvió esta llamada (liberadas + consumidas).
   *
   * @throws {Error} Si un lote no cuadra con su reserva.
   *
   * @example
   * ```ts
   * await finalize.onDocumentClosed(
   *   { documentId: 'doc-1', closureReason: DOCUMENT_CLOSURE_REASON_ENUM.DOCUMENT_REJECTED },
   *   manager,
   * );
   * ```
   */
  async onDocumentClosed(
    input: { documentId: string; closureReason: DOCUMENT_CLOSURE_REASON_ENUM },
    manager?: EntityManager,
  ): Promise<number> {
    const run = async (tx: EntityManager): Promise<number> => {
      const active = await this.credits.findActiveByDocument(
        input.documentId,
        tx,
      );
      let resolved = 0;
      for (const reservation of active) {
        if (reservation.creditType !== CREDIT_TYPE_ENUM.DOCUMENT_SIGNATURE) {
          continue;
        }
        const { applied } = await this.credits.release(
          { reservationId: reservation.id, reason: input.closureReason },
          tx,
        );
        if (applied) resolved += 1;
      }

      const { consumed } = await this.closeBiometricReservations.execute(
        input,
        tx,
      );
      return resolved + consumed;
    };

    return manager ? run(manager) : this.dataSource.transaction(run);
  }

  /**
   * Consume la reserva biométrica del intento.
   *
   * @param tx - Transacción.
   * @param input - Intento y documento.
   * @returns `true` si esta llamada la consumió.
   *
   * @example
   * ```ts
   * await this.consumeBiometric(tx, input);
   * ```
   */
  private async consumeBiometric(
    tx: EntityManager,
    input: BiometricSignatureSucceededInput,
  ): Promise<boolean> {
    const reservation = await this.credits.findByAttempt(
      input.biometricSignatureAttemptId,
      tx,
    );

    if (!reservation) {
      // Intentos abiertos antes de las reservas: su firma no se puede cobrar retroactivamente.
      this.logger.warn(
        `La firma biométrica del intento ${input.biometricSignatureAttemptId} se registró sin reserva de crédito.`,
      );
      return false;
    }

    return this.consumeReservation(tx, reservation);
  }

  /**
   * Consume la reserva documental del documento completado y escribe su recibo.
   *
   * @param tx - Transacción.
   * @param documentId - Documento completado.
   * @returns `true` si esta llamada la consumió.
   *
   * @example
   * ```ts
   * await this.consumeDocument(tx, 'doc-1');
   * ```
   */
  private async consumeDocument(
    tx: EntityManager,
    documentId: string,
  ): Promise<boolean> {
    const reservation = await this.credits.findDocumentReservation(
      documentId,
      tx,
    );

    if (!reservation) {
      // Documento biométrico creado antes de las reservas: se cobró al crearse.
      return false;
    }

    const consumed = await this.consumeReservation(
      tx,
      reservation,
      documentConsumptionLedgerKey(documentId),
    );

    if (consumed) {
      await tx
        .createQueryBuilder()
        .insert()
        .into(DocumentCreditConsumptionEntity)
        .values({
          documentId,
          billingProfileId: reservation.billingProfileId,
          creditLotId: reservation.creditLotId,
          creditsConsumed: reservation.quantity,
          signatureType: BILLING_SIGNATURE_TYPE_ENUM.BIOMETRIC,
          consumedAt: new Date(),
        })
        .orIgnore()
        .execute();
    }

    return consumed;
  }

  /**
   * Consume una reserva si sigue activa; registra por qué no si ya no lo está.
   *
   * @param tx - Transacción.
   * @param reservation - Reserva a consumir.
   * @param idempotencyKey - Clave del movimiento, si no es la de la reserva.
   * @returns `true` si esta llamada la consumió.
   *
   * @example
   * ```ts
   * await this.consumeReservation(tx, reservation);
   * ```
   */
  private async consumeReservation(
    tx: EntityManager,
    reservation: CreditReservationEntity,
    idempotencyKey?: string,
  ): Promise<boolean> {
    const { reservation: current, applied } = await this.credits.consume(
      { reservationId: reservation.id, idempotencyKey },
      tx,
    );

    if (
      !applied &&
      current.status !== CREDIT_RESERVATION_STATUS_ENUM.CONSUMED
    ) {
      this.logger.error(
        `La reserva ${current.id} (${current.creditType}) ya estaba en ${current.status} al registrarse la firma: no se cobró.`,
      );
    }

    return applied;
  }
}
