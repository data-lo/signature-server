import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';

import { IntegrationIdempotencyKeyEntity } from '../entities/integration-idempotency-key.entity';

/** Índice único que hace cumplir "una clave, un documento" por organización. */
const IDEMPOTENCY_UNIQUE_INDEX =
  'UQ_integration_idempotency_keys_organization_key';

/** Lo que se registra al usar una clave. */
export interface IdempotencyRecord {
  organizationId: string;
  apiKeyId: string;
  idempotencyKey: string;
  requestFingerprint: string;
  documentId: string;
}

/**
 * Acceso a datos de las claves de idempotencia de la API de integración. Sólo lee y escribe: la
 * regla —responder con el documento original o rechazar otro contenido— es del caso de uso.
 */
@Injectable()
export class IntegrationIdempotencyService {
  constructor(
    @InjectRepository(IntegrationIdempotencyKeyEntity)
    private readonly repository: Repository<IntegrationIdempotencyKeyEntity>,
  ) {}

  /**
   * La clave ya usada en la organización, si existe.
   *
   * @param organizationId - Organización de la API key.
   * @param idempotencyKey - Valor del header.
   * @returns El registro, o `null` si la clave es nueva.
   *
   * @example
   * ```ts
   * await idempotencyService.find('org-1', 'erp-pedido-8841');
   * ```
   */
  find(
    organizationId: string,
    idempotencyKey: string,
  ): Promise<IntegrationIdempotencyKeyEntity | null> {
    return this.repository.findOneBy({ organizationId, idempotencyKey });
  }

  /**
   * Registra la clave dentro de la transacción que crea el documento.
   *
   * @param manager - Transacción del alta.
   * @param record - Organización, llave, clave, huella y documento.
   * @returns Nada.
   *
   * @throws {QueryFailedError} Con `UQ_integration_idempotency_keys_organization_key` si otra
   *   petición ya usó la clave; revierte el alta entera.
   *
   * @example
   * ```ts
   * await idempotencyService.record(manager, { organizationId, apiKeyId, idempotencyKey, requestFingerprint, documentId });
   * ```
   */
  async record(
    manager: EntityManager,
    record: IdempotencyRecord,
  ): Promise<void> {
    await manager.getRepository(IntegrationIdempotencyKeyEntity).insert(record);
  }
}

/**
 * Reconoce el choque contra el índice único de claves de idempotencia.
 *
 * @param error - Lo que haya lanzado el alta.
 * @returns `true` si otra petición ya registró esa clave.
 *
 * @example
 * ```ts
 * if (isIdempotencyKeyConflict(error)) { … }
 * ```
 */
export function isIdempotencyKeyConflict(error: unknown): boolean {
  const driverError = (error as { driverError?: Record<string, unknown> })
    ?.driverError;

  return (
    driverError?.code === '23505' &&
    driverError?.constraint === IDEMPOTENCY_UNIQUE_INDEX
  );
}
