import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, LessThanOrEqual, Repository } from 'typeorm';

import {
  INTEGRATION_IDEMPOTENCY_STATUS_ENUM,
  IntegrationIdempotencyKeyEntity,
} from '../entities/integration-idempotency-key.entity';
import {
  IdempotencyKeyInProgressException,
  IdempotencyKeyMismatchException,
} from '../exceptions/integration-document.exceptions';

/** Cuánto vive una reserva sin completarse antes de darla por abandonada. */
export const IDEMPOTENCY_PROCESSING_LEASE_MS = 10 * 60 * 1000;

/** Cuánto se conserva una clave completada: dentro de ese plazo, un reintento no crea nada. */
export const IDEMPOTENCY_RETENTION_MS = 24 * 60 * 60 * 1000;

/** La clave que se pide reservar. */
export interface IdempotencyRequest {
  apiKeyId: string;
  idempotencyKey: string;
  /** SHA-256 del archivo y del payload (`buildRequestFingerprint`). */
  requestHash: string;
}

/** Resultado de reservar: la clave quedó para esta petición, o ya tiene documento. */
export type IdempotencyReservation =
  | { kind: 'RESERVED'; reservationId: string }
  | { kind: 'REPLAY'; documentId: string };

/**
 * Las claves de idempotencia de la API de integración: reservar → completar → liberar.
 *
 * - `reserve`, ANTES de subir el archivo o crear al creador: inserta la clave `PROCESSING`. Si ya
 *   existe, decide sin tocar nada más: mismo contenido y completada → repetición; mismo contenido
 *   en curso → 409; otro contenido → 409. Una clave vencida se libera y se vuelve a reservar.
 * - `complete`, DENTRO de la transacción del documento: la pasa a `COMPLETED` con su documento.
 *   Si la reserva ya no es de esta petición (venció y otra la tomó), lanza y el alta se deshace.
 * - `release`, si el alta falla: borra la reserva para que el cliente pueda reintentar.
 *
 * La unicidad la garantiza `UQ_integration_idempotency_keys_api_key_key`; nada de esto depende de
 * que dos peticiones no lleguen a la vez.
 */
@Injectable()
export class IntegrationIdempotencyService {
  constructor(
    @InjectRepository(IntegrationIdempotencyKeyEntity)
    private readonly repository: Repository<IntegrationIdempotencyKeyEntity>,
  ) {}

  /**
   * Reserva la clave para esta petición, o resuelve qué hacer si ya está usada.
   *
   * @param request - Llave, clave y huella de la petición.
   * @returns `RESERVED` con la reserva, o `REPLAY` con el documento ya creado.
   *
   * @throws {IdempotencyKeyMismatchException} (409) Si la clave se usó con otro contenido.
   * @throws {IdempotencyKeyInProgressException} (409) Si otra petición con la misma clave sigue
   *   en curso.
   *
   * @example
   * ```ts
   * const reservation = await idempotencyService.reserve({ apiKeyId, idempotencyKey, requestHash });
   * if (reservation.kind === 'REPLAY') return reservation.documentId;
   * ```
   */
  async reserve(request: IdempotencyRequest): Promise<IdempotencyReservation> {
    // Dos vueltas como máximo: la segunda sólo ocurre si la clave existente estaba vencida.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const inserted = await this.repository
        .createQueryBuilder()
        .insert()
        .values({
          apiKeyId: request.apiKeyId,
          idempotencyKey: request.idempotencyKey,
          requestHash: request.requestHash,
          status: INTEGRATION_IDEMPOTENCY_STATUS_ENUM.PROCESSING,
          documentId: null,
          expiresAt: new Date(Date.now() + IDEMPOTENCY_PROCESSING_LEASE_MS),
        })
        .orIgnore()
        .returning(['id'])
        .execute();

      const reservationId = (inserted.raw as { id: string }[])[0]?.id;
      if (reservationId) {
        return { kind: 'RESERVED', reservationId };
      }

      const existing = await this.repository.findOneBy({
        apiKeyId: request.apiKeyId,
        idempotencyKey: request.idempotencyKey,
      });
      if (!existing) continue;

      if (existing.expiresAt.getTime() <= Date.now()) {
        await this.repository.delete({
          id: existing.id,
          expiresAt: LessThanOrEqual(new Date()),
        });
        continue;
      }

      if (existing.requestHash !== request.requestHash) {
        throw new IdempotencyKeyMismatchException();
      }
      if (
        existing.status === INTEGRATION_IDEMPOTENCY_STATUS_ENUM.PROCESSING ||
        !existing.documentId
      ) {
        throw new IdempotencyKeyInProgressException();
      }
      return { kind: 'REPLAY', documentId: existing.documentId };
    }

    throw new IdempotencyKeyInProgressException();
  }

  /**
   * Marca la reserva como completada con su documento, dentro de la transacción del alta.
   *
   * @param manager - Transacción del documento.
   * @param reservationId - Reserva devuelta por `reserve`.
   * @param documentId - Documento recién guardado.
   * @returns Nada.
   *
   * @throws {IdempotencyKeyInProgressException} (409) Si la reserva ya no está `PROCESSING` (venció
   *   y la tomó otra petición); revierte el alta.
   *
   * @example
   * ```ts
   * await idempotencyService.complete(manager, reservation.reservationId, document.id);
   * ```
   */
  async complete(
    manager: EntityManager,
    reservationId: string,
    documentId: string,
  ): Promise<void> {
    const result = await manager
      .getRepository(IntegrationIdempotencyKeyEntity)
      .update(
        {
          id: reservationId,
          status: INTEGRATION_IDEMPOTENCY_STATUS_ENUM.PROCESSING,
        },
        {
          status: INTEGRATION_IDEMPOTENCY_STATUS_ENUM.COMPLETED,
          documentId,
          expiresAt: new Date(Date.now() + IDEMPOTENCY_RETENTION_MS),
        },
      );

    if (!result.affected) {
      throw new IdempotencyKeyInProgressException();
    }
  }

  /**
   * Libera una reserva que no llegó a completarse. Nunca borra una clave completada.
   *
   * @param reservationId - Reserva devuelta por `reserve`.
   * @returns Nada.
   *
   * @example
   * ```ts
   * await idempotencyService.release(reservation.reservationId);
   * ```
   */
  async release(reservationId: string): Promise<void> {
    await this.repository.delete({
      id: reservationId,
      status: INTEGRATION_IDEMPOTENCY_STATUS_ENUM.PROCESSING,
    });
  }
}
