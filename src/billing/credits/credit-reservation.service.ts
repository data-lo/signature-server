import { HttpException, Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';

import { countAvailableCredits } from './count-available-credits.util';
import { CreditLotEntity } from './credit-lot.entity';
import { CreditLedgerEntryEntity } from './credit-ledger-entry.entity';
import { recordCreditLedgerEntry } from './credit-ledger.util';
import { CreditReservationEntity } from './credit-reservation.entity';
import { CREDIT_LEDGER_MOVEMENT_TYPE_ENUM } from '../enums/credit-ledger-movement-type.enum';
import { CREDIT_RESERVATION_STATUS_ENUM } from '../enums/credit-reservation-status.enum';
import { CREDIT_TYPE_ENUM } from '../enums/credit-type.enum';
import {
  InsufficientBiometricCreditsException,
  InsufficientDocumentCreditsException,
} from '../exceptions/billing.exceptions';

/** Qué reservar y por qué. */
export interface ReserveCreditsInput {
  billingProfileId: string;
  creditType: CREDIT_TYPE_ENUM;
  quantity: number;
  /** Documento que paga la reserva, o al que pertenece el colaborador biométrico. */
  documentId: string | null;
  /** Colaborador biométrico al que se le aparta el crédito; obligatorio en las biométricas. */
  collaboratorId?: string | null;
  /** Intento de Didit, si ya existe; una biométrica puede reservarse antes de abrir la sesión. */
  biometricSignatureAttemptId: string | null;
  /** Cuándo puede liberarla el job de expiración; `null` = no vence sola. */
  expiresAt: Date | null;
  /**
   * Identifica el hecho de reservar (p. ej. `reserve:BIOMETRIC_SIGNATURE:<intento>`). Un segundo
   * `reserve` con la misma clave devuelve la reserva del primero, sin bloquear más saldo.
   */
  idempotencyKey: string;
  metadata?: Record<string, unknown>;
}

/** Resultado de `reserve`. */
export interface ReserveCreditsResult {
  reservation: CreditReservationEntity;
  /** `false` si la clave ya había reservado y se devolvió esa reserva. */
  created: boolean;
}

/** Resultado de `consume` y `release`. */
export interface SettleReservationResult {
  /** La reserva con su estado vigente después de la operación. */
  reservation: CreditReservationEntity;
  /**
   * `true` si esta llamada movió la reserva desde `ACTIVE`. `false` si ya estaba resuelta (un
   * reintento): no se tocó ningún saldo.
   */
  applied: boolean;
}

/** Cuántos lotes se prueban antes de rendirse cuando otros procesos los van vaciando. */
const MAX_LOT_CANDIDATES = 20;

/**
 * Operaciones transaccionales sobre créditos: reservar, consumir y liberar.
 *
 * **Es un servicio técnico**: no decide CUÁNDO cobrar, eso lo deciden los casos de uso
 * (`ReserveDocumentCreditUseCase`, `ReserveBiometricSignatureCreditsUseCase`,
 * `FinalizeBiometricSignatureCreditsUseCase`, `ReleaseExpiredCreditReservationsUseCase`). Ningún
 * controller lo llama directo.
 *
 * Garantías:
 * - **Atomicidad.** Lote, reserva y ledger cambian en una sola transacción: la del llamador si
 *   pasa un `EntityManager`, o una propia.
 * - **Sin saldos negativos.** El bloqueo de saldo es un `UPDATE ... WHERE remaining - reserved >=
 *   quantity`: el motor resuelve la carrera por el último crédito sobre la fila que la escritura
 *   bloquea. Los `CHECK` de `credit_lots` son la última red.
 * - **Idempotencia.** `reserve` serializa por su clave con un advisory lock y devuelve la reserva
 *   ya hecha; `consume` y `release` sólo mueven una reserva `ACTIVE` (`UPDATE` condicionado), así
 *   que un reintento no cobra ni devuelve dos veces.
 * - **Ledger.** Cada cambio de `reserved` o `remaining` escribe su movimiento.
 */
@Injectable()
export class CreditReservationService {
  private readonly logger = new Logger(CreditReservationService.name);

  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  /**
   * Bloquea créditos de un lote elegible y registra la reserva y su movimiento `RESERVE`.
   *
   * @param input - Perfil, tipo, cantidad, objeto que paga y clave de idempotencia.
   * @param manager - Transacción del llamador; sin ella abre una propia.
   * @returns La reserva creada, o la que ya había creado esta misma clave.
   *
   * @throws {InsufficientDocumentCreditsException} (402) Sin saldo documental disponible.
   * @throws {InsufficientBiometricCreditsException} (402) Sin saldo biométrico disponible.
   * @throws {Error} Si una biométrica no trae documento y colaborador, o no es de 1 crédito.
   * @throws {QueryFailedError} Si ya hay otra reserva activa para el mismo documento, colaborador o
   *   intento con otra clave (índices únicos parciales), o si el colaborador no es del documento.
   *
   * @example
   * ```ts
   * const { reservation } = await credits.reserve({
   *   billingProfileId: 'bp-1',
   *   creditType: CREDIT_TYPE_ENUM.BIOMETRIC_SIGNATURE,
   *   quantity: 1,
   *   documentId: 'doc-1',
   *   collaboratorId: 'col-1',
   *   biometricSignatureAttemptId: null,
   *   expiresAt: null,
   *   idempotencyKey: 'reserve:BIOMETRIC_SIGNATURE:document:doc-1:collaborator:col-1',
   * });
   * ```
   */
  async reserve(
    input: ReserveCreditsInput,
    manager?: EntityManager,
  ): Promise<ReserveCreditsResult> {
    return this.inTransaction(manager, (tx) => this.reserveIn(tx, input));
  }

  /**
   * Cobra una reserva activa: baja `remaining` y `reserved` del lote y registra `CONSUME`.
   *
   * @param input.reservationId - Reserva a cobrar.
   * @param input.idempotencyKey - Clave del movimiento; por defecto `consume:reservation:<id>`.
   * @param input.metadata - Contexto del movimiento.
   * @param manager - Transacción del llamador; sin ella abre una propia.
   * @returns La reserva y si esta llamada la cobró. Una ya resuelta vuelve con `applied: false`.
   *
   * @throws {Error} Si la reserva no existe, o si el lote no tiene los créditos que la reserva dice
   *   haber bloqueado (inconsistencia: la transacción se deshace).
   *
   * @example
   * ```ts
   * const { applied } = await credits.consume({ reservationId: 'res-1' });
   * ```
   */
  async consume(
    input: {
      reservationId: string;
      idempotencyKey?: string;
      metadata?: Record<string, unknown>;
    },
    manager?: EntityManager,
  ): Promise<SettleReservationResult> {
    return this.inTransaction(manager, (tx) =>
      this.settleIn(tx, {
        reservationId: input.reservationId,
        target: CREDIT_RESERVATION_STATUS_ENUM.CONSUMED,
        idempotencyKey:
          input.idempotencyKey ?? `consume:reservation:${input.reservationId}`,
        metadata: input.metadata,
      }),
    );
  }

  /**
   * Devuelve al saldo una reserva activa: baja sólo `reserved` del lote y registra `RELEASE`.
   *
   * @param input.reservationId - Reserva a liberar.
   * @param input.reason - Por qué se libera; queda en el ledger.
   * @param input.expired - `true` si la libera el vencimiento (estado `EXPIRED`); si no, `RELEASED`.
   * @param manager - Transacción del llamador; sin ella abre una propia.
   * @returns La reserva y si esta llamada la liberó. Una ya resuelta vuelve con `applied: false`.
   *
   * @throws {Error} Si la reserva no existe o el lote no tiene bloqueados los créditos de la reserva.
   *
   * @example
   * ```ts
   * await credits.release({ reservationId: 'res-1', reason: 'DIDIT_DECLINED' });
   * ```
   */
  async release(
    input: { reservationId: string; reason: string; expired?: boolean },
    manager?: EntityManager,
  ): Promise<SettleReservationResult> {
    return this.inTransaction(manager, (tx) =>
      this.settleIn(tx, {
        reservationId: input.reservationId,
        target: input.expired
          ? CREDIT_RESERVATION_STATUS_ENUM.EXPIRED
          : CREDIT_RESERVATION_STATUS_ENUM.RELEASED,
        idempotencyKey: `release:reservation:${input.reservationId}`,
        metadata: { reason: input.reason },
      }),
    );
  }

  /**
   * Primer lote del que se reservaría: del perfil y del tipo pedidos, vigente y con
   * `remaining - reserved >= quantity`. No bloquea nada; es una lectura.
   *
   * El orden es el mismo del consumo de documentos: `priority` descendente, caducidad más próxima
   * y lote más viejo (ver `ConsumeDocumentCreditUseCase`).
   *
   * @param input - Perfil, tipo de crédito y cantidad.
   * @param manager - Transacción en curso, si la hay.
   * @returns El lote elegible, o `null` si no hay saldo.
   *
   * @example
   * ```ts
   * const lot = await credits.findAvailableLot({
   *   billingProfileId: 'bp-1',
   *   creditType: CREDIT_TYPE_ENUM.BIOMETRIC_SIGNATURE,
   *   quantity: 1,
   * });
   * ```
   */
  async findAvailableLot(
    input: {
      billingProfileId: string;
      creditType: CREDIT_TYPE_ENUM;
      quantity: number;
    },
    manager?: EntityManager,
  ): Promise<CreditLotEntity | null> {
    const [lot] = await this.findAvailableLots(
      manager ?? this.dataSource.manager,
      input,
      1,
    );
    return lot ?? null;
  }

  /**
   * Reserva más reciente de un intento biométrico, en cualquier estado.
   *
   * @param biometricSignatureAttemptId - Intento.
   * @param manager - Transacción en curso, si la hay.
   * @returns La reserva, o `null` si el intento nunca reservó.
   *
   * @example
   * ```ts
   * const reservation = await credits.findByAttempt('att-1');
   * ```
   */
  findByAttempt(
    biometricSignatureAttemptId: string,
    manager?: EntityManager,
  ): Promise<CreditReservationEntity | null> {
    return (manager ?? this.dataSource.manager)
      .getRepository(CreditReservationEntity)
      .findOne({
        where: {
          biometricSignatureAttemptId,
          creditType: CREDIT_TYPE_ENUM.BIOMETRIC_SIGNATURE,
        },
        order: { createdAt: 'DESC' },
      });
  }

  /**
   * Reserva biométrica ACTIVA de un colaborador en un documento (hay a lo sumo una).
   *
   * @param input.documentId - Documento.
   * @param input.collaboratorId - Colaborador biométrico.
   * @param manager - Transacción en curso, si la hay.
   * @returns La reserva activa, o `null` si el colaborador no tiene crédito apartado.
   *
   * @example
   * ```ts
   * const reservation = await credits.findActiveBiometricByCollaborator({ documentId: 'doc-1', collaboratorId: 'col-1' });
   * ```
   */
  findActiveBiometricByCollaborator(
    input: { documentId: string; collaboratorId: string },
    manager?: EntityManager,
  ): Promise<CreditReservationEntity | null> {
    return (manager ?? this.dataSource.manager)
      .getRepository(CreditReservationEntity)
      .findOne({
        where: {
          documentId: input.documentId,
          collaboratorId: input.collaboratorId,
          creditType: CREDIT_TYPE_ENUM.BIOMETRIC_SIGNATURE,
          status: CREDIT_RESERVATION_STATUS_ENUM.ACTIVE,
        },
      });
  }

  /**
   * Asocia un intento de Didit a la reserva biométrica activa de su colaborador, en vez de crear
   * otra. Si la reserva ya apuntaba a otro intento (uno anterior que terminó sin liberarla), pasa a
   * apuntar al nuevo: el crédito es del colaborador, no del intento.
   *
   * @param input.reservationId - Reserva biométrica activa.
   * @param input.biometricSignatureAttemptId - Intento recién abierto.
   * @param manager - Transacción en curso, si la hay.
   * @returns La reserva actualizada, o `null` si ya no estaba activa (otro proceso la resolvió).
   *
   * @throws {QueryFailedError} Si el intento ya está asociado a otra reserva activa.
   *
   * @example
   * ```ts
   * await credits.attachAttempt({ reservationId: 'res-1', biometricSignatureAttemptId: 'att-1' });
   * ```
   */
  async attachAttempt(
    input: { reservationId: string; biometricSignatureAttemptId: string },
    manager?: EntityManager,
  ): Promise<CreditReservationEntity | null> {
    const tx = manager ?? this.dataSource.manager;
    const repository = tx.getRepository(CreditReservationEntity);

    const current = await repository.findOne({
      where: { id: input.reservationId },
    });
    if (
      current?.biometricSignatureAttemptId &&
      current.biometricSignatureAttemptId !== input.biometricSignatureAttemptId
    ) {
      this.logger.warn(
        `La reserva ${current.id} pasa del intento ${current.biometricSignatureAttemptId} al ${input.biometricSignatureAttemptId}.`,
      );
    }

    const result = await tx
      .createQueryBuilder()
      .update(CreditReservationEntity)
      .set({ biometricSignatureAttemptId: input.biometricSignatureAttemptId })
      .where('id = :id', { id: input.reservationId })
      .andWhere('credit_type = :creditType', {
        creditType: CREDIT_TYPE_ENUM.BIOMETRIC_SIGNATURE,
      })
      .andWhere('status = :active', {
        active: CREDIT_RESERVATION_STATUS_ENUM.ACTIVE,
      })
      .execute();
    if (result.affected !== 1) {
      return null;
    }

    return repository.findOne({ where: { id: input.reservationId } });
  }

  /**
   * Reserva documental más reciente de un documento, en cualquier estado.
   *
   * @param documentId - Documento.
   * @param manager - Transacción en curso, si la hay.
   * @returns La reserva, o `null` si el documento nunca reservó (p. ej. uno no biométrico).
   *
   * @example
   * ```ts
   * const reservation = await credits.findDocumentReservation('doc-1');
   * ```
   */
  findDocumentReservation(
    documentId: string,
    manager?: EntityManager,
  ): Promise<CreditReservationEntity | null> {
    return (manager ?? this.dataSource.manager)
      .getRepository(CreditReservationEntity)
      .findOne({
        where: { documentId, creditType: CREDIT_TYPE_ENUM.DOCUMENT_SIGNATURE },
        order: { createdAt: 'DESC' },
      });
  }

  /**
   * Reservas activas de un documento, documentales y biométricas.
   *
   * @param documentId - Documento.
   * @param manager - Transacción en curso, si la hay.
   * @returns Las reservas `ACTIVE`, de cualquier tipo.
   *
   * @example
   * ```ts
   * const active = await credits.findActiveByDocument('doc-1');
   * ```
   */
  findActiveByDocument(
    documentId: string,
    manager?: EntityManager,
  ): Promise<CreditReservationEntity[]> {
    return (manager ?? this.dataSource.manager)
      .getRepository(CreditReservationEntity)
      .find({
        where: { documentId, status: CREDIT_RESERVATION_STATUS_ENUM.ACTIVE },
        order: { createdAt: 'ASC' },
      });
  }

  /**
   * Cuerpo de `reserve`, ya dentro de la transacción.
   *
   * @param tx - Transacción.
   * @param input - Datos de la reserva.
   * @returns La reserva creada o la existente para la clave.
   *
   * @throws {InsufficientDocumentCreditsException | InsufficientBiometricCreditsException} Sin saldo.
   *
   * @example
   * ```ts
   * await this.reserveIn(tx, input);
   * ```
   */
  private async reserveIn(
    tx: EntityManager,
    input: ReserveCreditsInput,
  ): Promise<ReserveCreditsResult> {
    if (!Number.isInteger(input.quantity) || input.quantity <= 0) {
      throw new Error(
        `Cantidad de créditos a reservar inválida: ${input.quantity}`,
      );
    }
    if (
      input.creditType === CREDIT_TYPE_ENUM.BIOMETRIC_SIGNATURE &&
      (!input.documentId || !input.collaboratorId || input.quantity !== 1)
    ) {
      throw new Error(
        'Una reserva biométrica necesita documento y colaborador, y bloquea exactamente 1 crédito.',
      );
    }

    // Dos reintentos simultáneos de la misma reserva se forman aquí: el segundo ve la del primero.
    await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
      input.idempotencyKey,
    ]);

    const previous = await this.findReservationByLedgerKey(
      tx,
      input.idempotencyKey,
    );
    if (previous) {
      return { reservation: previous, created: false };
    }

    const creditLotId = await this.blockCredits(tx, input);
    if (!creditLotId) {
      const available = await countAvailableCredits(
        tx,
        input.billingProfileId,
        input.creditType,
      );
      throw insufficientCredits(
        input.creditType,
        input.quantity,
        available,
        `Sin lotes ${input.creditType} con saldo disponible para el perfil ${input.billingProfileId}.`,
      );
    }

    const reservations = tx.getRepository(CreditReservationEntity);
    const reservation = await reservations.save(
      reservations.create({
        billingProfileId: input.billingProfileId,
        creditLotId,
        creditType: input.creditType,
        documentId: input.documentId,
        collaboratorId: input.collaboratorId ?? null,
        biometricSignatureAttemptId: input.biometricSignatureAttemptId,
        quantity: input.quantity,
        status: CREDIT_RESERVATION_STATUS_ENUM.ACTIVE,
        expiresAt: input.expiresAt,
        consumedAt: null,
        releasedAt: null,
      }),
    );

    await recordCreditLedgerEntry(tx, {
      billingProfileId: input.billingProfileId,
      creditLotId,
      creditType: input.creditType,
      movementType: CREDIT_LEDGER_MOVEMENT_TYPE_ENUM.RESERVE,
      quantity: input.quantity,
      idempotencyKey: input.idempotencyKey,
      creditReservationId: reservation.id,
      documentId: input.documentId,
      biometricSignatureAttemptId: input.biometricSignatureAttemptId,
      metadata: withCollaborator(input.metadata, input.collaboratorId),
    });

    this.logger.log(
      `Reserva ${reservation.id}: ${input.quantity} crédito(s) ${input.creditType} del lote ${creditLotId} (perfil ${input.billingProfileId}).`,
    );

    return { reservation, created: true };
  }

  /**
   * Mueve una reserva activa a `CONSUMED`, `RELEASED` o `EXPIRED` y ajusta su lote.
   *
   * El `UPDATE` condicionado al estado `ACTIVE` es el que decide quién resuelve la reserva: un
   * segundo intento (otro webhook, el job) encuentra 0 filas y no toca el lote.
   *
   * @param tx - Transacción.
   * @param params - Reserva, estado destino, clave y contexto del movimiento.
   * @returns La reserva vigente y si esta llamada la resolvió.
   *
   * @throws {Error} Si la reserva no existe o el lote no cuadra con ella.
   *
   * @example
   * ```ts
   * await this.settleIn(tx, { reservationId, target: CREDIT_RESERVATION_STATUS_ENUM.CONSUMED, idempotencyKey });
   * ```
   */
  private async settleIn(
    tx: EntityManager,
    params: {
      reservationId: string;
      target: CREDIT_RESERVATION_STATUS_ENUM;
      idempotencyKey: string;
      metadata?: Record<string, unknown>;
    },
  ): Promise<SettleReservationResult> {
    const consuming = params.target === CREDIT_RESERVATION_STATUS_ENUM.CONSUMED;
    const now = new Date();

    const claim = await tx
      .createQueryBuilder()
      .update(CreditReservationEntity)
      .set({
        status: params.target,
        ...(consuming ? { consumedAt: now } : { releasedAt: now }),
      })
      .where('id = :id', { id: params.reservationId })
      .andWhere('status = :active', {
        active: CREDIT_RESERVATION_STATUS_ENUM.ACTIVE,
      })
      .execute();

    const reservation = await tx
      .getRepository(CreditReservationEntity)
      .findOne({ where: { id: params.reservationId } });
    if (!reservation) {
      throw new Error(
        `La reserva de créditos ${params.reservationId} no existe.`,
      );
    }

    if (claim.affected !== 1) {
      return { reservation, applied: false };
    }

    const lotUpdate = tx
      .createQueryBuilder()
      .update(CreditLotEntity)
      .set(
        consuming
          ? {
              remaining: () => '"remaining" - :quantity',
              reserved: () => '"reserved" - :quantity',
            }
          : { reserved: () => '"reserved" - :quantity' },
      )
      .where('id = :lotId', { lotId: reservation.creditLotId })
      .andWhere('billing_profile_id = :profileId', {
        profileId: reservation.billingProfileId,
      })
      .andWhere('reserved >= :quantity')
      .setParameter('quantity', reservation.quantity);

    if (consuming) {
      lotUpdate.andWhere('remaining >= :quantity');
    }

    const lotResult = await lotUpdate.execute();
    if (lotResult.affected !== 1) {
      throw new Error(
        `El lote ${reservation.creditLotId} no tiene bloqueados los ${reservation.quantity} crédito(s) de la reserva ${reservation.id}.`,
      );
    }

    const recorded = await recordCreditLedgerEntry(tx, {
      billingProfileId: reservation.billingProfileId,
      creditLotId: reservation.creditLotId,
      creditType: reservation.creditType,
      movementType: consuming
        ? CREDIT_LEDGER_MOVEMENT_TYPE_ENUM.CONSUME
        : CREDIT_LEDGER_MOVEMENT_TYPE_ENUM.RELEASE,
      quantity: reservation.quantity,
      idempotencyKey: params.idempotencyKey,
      creditReservationId: reservation.id,
      documentId: reservation.documentId,
      biometricSignatureAttemptId: reservation.biometricSignatureAttemptId,
      metadata: withCollaborator(params.metadata, reservation.collaboratorId),
    });
    if (!recorded) {
      // La reserva estaba ACTIVE, así que la clave sólo puede venir de otro camino (p. ej. un
      // consumo inmediato del mismo documento). Cobrar otra vez sería doble cargo.
      throw new Error(
        `El movimiento ${params.idempotencyKey} ya estaba registrado; la reserva ${reservation.id} no se resuelve dos veces.`,
      );
    }

    this.logger.log(
      `Reserva ${reservation.id} → ${params.target} (${reservation.quantity} crédito(s) ${reservation.creditType}, lote ${reservation.creditLotId}).`,
    );

    return { reservation, applied: true };
  }

  /**
   * Sube `reserved` en el primer lote elegible que lo acepte.
   *
   * @param tx - Transacción.
   * @param input - Perfil, tipo y cantidad.
   * @returns El lote bloqueado, o `null` si ninguno tenía saldo.
   *
   * @example
   * ```ts
   * const lotId = await this.blockCredits(tx, input);
   * ```
   */
  private async blockCredits(
    tx: EntityManager,
    input: Pick<
      ReserveCreditsInput,
      'billingProfileId' | 'creditType' | 'quantity'
    >,
  ): Promise<string | null> {
    const candidates = await this.findAvailableLots(
      tx,
      input,
      MAX_LOT_CANDIDATES,
    );

    // Otra transacción pudo agotar un candidato entre la lista y el UPDATE: se prueba el siguiente.
    for (const lot of candidates) {
      const result = await tx
        .createQueryBuilder()
        .update(CreditLotEntity)
        .set({ reserved: () => '"reserved" + :quantity' })
        .where('id = :id', { id: lot.id })
        .andWhere('billing_profile_id = :profileId', {
          profileId: input.billingProfileId,
        })
        .andWhere('credit_type = :creditType', {
          creditType: input.creditType,
        })
        // Esta condición es la que hace atómica la reserva: nunca deja `reserved > remaining`.
        .andWhere('remaining - reserved >= :quantity')
        .andWhere('(expires_at IS NULL OR expires_at > now())')
        .setParameter('quantity', input.quantity)
        .execute();

      if (result.affected) {
        return lot.id;
      }
    }

    return null;
  }

  /**
   * Lotes elegibles en orden de gasto.
   *
   * @param manager - Conexión o transacción.
   * @param input - Perfil, tipo y cantidad.
   * @param limit - Máximo de lotes a devolver.
   * @returns Los lotes elegibles.
   *
   * @example
   * ```ts
   * await this.findAvailableLots(tx, input, 20);
   * ```
   */
  private findAvailableLots(
    manager: EntityManager,
    input: {
      billingProfileId: string;
      creditType: CREDIT_TYPE_ENUM;
      quantity: number;
    },
    limit: number,
  ): Promise<CreditLotEntity[]> {
    return manager
      .createQueryBuilder(CreditLotEntity, 'lot')
      .where('lot.billing_profile_id = :billingProfileId', {
        billingProfileId: input.billingProfileId,
      })
      .andWhere('lot.credit_type = :creditType', {
        creditType: input.creditType,
      })
      .andWhere('lot.remaining - lot.reserved >= :quantity', {
        quantity: input.quantity,
      })
      .andWhere('(lot.expires_at IS NULL OR lot.expires_at > now())')
      .orderBy('lot.priority', 'DESC')
      .addOrderBy('lot.expires_at', 'ASC', 'NULLS LAST')
      .addOrderBy('lot.created_at', 'ASC')
      .limit(limit)
      .getMany();
  }

  /**
   * Reserva que ya registró una clave de idempotencia, si la hay.
   *
   * @param tx - Transacción.
   * @param idempotencyKey - Clave del movimiento `RESERVE`.
   * @returns La reserva, o `null` si la clave no se ha usado.
   *
   * @example
   * ```ts
   * await this.findReservationByLedgerKey(tx, 'reserve:DOCUMENT_SIGNATURE:doc-1');
   * ```
   */
  private async findReservationByLedgerKey(
    tx: EntityManager,
    idempotencyKey: string,
  ): Promise<CreditReservationEntity | null> {
    const entry = await tx
      .getRepository(CreditLedgerEntryEntity)
      .findOne({ where: { idempotencyKey } });
    if (!entry?.creditReservationId) {
      return null;
    }

    return tx
      .getRepository(CreditReservationEntity)
      .findOne({ where: { id: entry.creditReservationId } });
  }

  /**
   * Ejecuta en la transacción del llamador o en una propia.
   *
   * @param manager - Transacción del llamador, si la hay.
   * @param work - Trabajo a ejecutar.
   * @returns Lo que devuelva `work`.
   *
   * @example
   * ```ts
   * await this.inTransaction(manager, (tx) => this.reserveIn(tx, input));
   * ```
   */
  private inTransaction<T>(
    manager: EntityManager | undefined,
    work: (tx: EntityManager) => Promise<T>,
  ): Promise<T> {
    return manager ? work(manager) : this.dataSource.transaction(work);
  }
}

/**
 * Excepción 402 que corresponde a cada tipo de crédito.
 *
 * @param creditType - Tipo sin saldo.
 * @param required - Créditos pedidos.
 * @param available - Créditos disponibles.
 * @param detail - Detalle para el log.
 * @returns La excepción a lanzar.
 *
 * @example
 * ```ts
 * throw insufficientCredits(CREDIT_TYPE_ENUM.BIOMETRIC_SIGNATURE, 1, 0);
 * ```
 */
export function insufficientCredits(
  creditType: CREDIT_TYPE_ENUM,
  required: number,
  available: number,
  detail?: string,
): HttpException {
  return creditType === CREDIT_TYPE_ENUM.BIOMETRIC_SIGNATURE
    ? new InsufficientBiometricCreditsException(required, available, detail)
    : new InsufficientDocumentCreditsException(required, available, detail);
}

/**
 * Metadatos del movimiento con el colaborador de la reserva, que el ledger no tiene como columna.
 *
 * @param metadata - Metadatos del llamador.
 * @param collaboratorId - Colaborador de la reserva biométrica, si lo hay.
 * @returns Los metadatos con `collaboratorId`, o `null` si no hay nada que guardar.
 *
 * @example
 * ```ts
 * withCollaborator({ reason: 'DIDIT_DECLINED' }, 'col-1'); // { reason: 'DIDIT_DECLINED', collaboratorId: 'col-1' }
 * ```
 */
function withCollaborator(
  metadata: Record<string, unknown> | undefined,
  collaboratorId: string | null | undefined,
): Record<string, unknown> | null {
  if (!collaboratorId) {
    return metadata ?? null;
  }
  return { ...metadata, collaboratorId };
}
