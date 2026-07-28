import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { AuditChainEntity } from './entities/audit-chain.entity';
import { AUDIT_TYPE_ENUM } from './enums/audit-type.enum';
import { HashService } from 'src/shared/hash/hash.service';

/** Genesis Hash: chainHash de la primera fila del sistema (no hay ninguna fila anterior que encadenar). */
export const AUDIT_CHAIN_GENESIS_HASH = '0'.repeat(64);

/**
 * Clave arbitraria y fija para el advisory lock de Postgres (pg_advisory_xact_lock). Cualquier
 * bigint sirve — lo único que importa es que sea SIEMPRE la misma, para que todas las
 * instancias del servicio (y todos los eventos concurrentes) compitan por el mismo lock.
 */
const AUDIT_CHAIN_LOCK_KEY = 918273645;

export interface RecordAuditEventParams {
  documentId: string;
  auditType: AUDIT_TYPE_ENUM;
  metadata?: Record<string, unknown>;
  timestamp?: Date;
}

/**
 * Módulo de Auditoría e Integridad Global de BD (ver diagrama ER-V2, entidad "audit"): a
 * diferencia de DocumentTransactionService (que encadena solo dentro de un mismo documento),
 * esto encadena sobre TODA la base de datos — el chainHash de cada fila nueva es el actualHash
 * de la fila con el MAX(id) GLOBAL anterior, sin importar el documento.
 *
 * `recordEvent` se invoca desde consumers de Kafka (ver DocumentEventsConsumer), nunca
 * síncronamente desde el flujo HTTP — así el cómputo/escritura de la cadena de auditoría nunca
 * agrega latencia a la respuesta al usuario ni puede tumbar la transacción principal.
 *
 * Procesamiento estrictamente secuencial (FIFO): "leer el MAX(id) actual, calcular el nuevo
 * hash, insertar" es una sección crítica clásica — sin serializarla, dos eventos casi
 * simultáneos (dos consumers, o dos particiones de Kafka procesando en paralelo) podrían leer
 * el mismo "último" registro y encadenar dos filas nuevas al mismo padre, bifurcando la cadena
 * en vez de mantenerla lineal. `pg_advisory_xact_lock` serializa esta sección crítica a nivel de
 * Postgres (no solo en memoria de este proceso), así que la garantía se sostiene incluso con
 * múltiples instancias del servidor corriendo contra la misma base de datos. El lock es
 * transaccional (`_xact_`): Postgres lo libera solo automáticamente al hacer commit/rollback,
 * sin necesidad de liberarlo manualmente ni riesgo de dejarlo tomado si el proceso truena.
 */
@Injectable()
export class AuditChainService {
  private readonly logger = new Logger(AuditChainService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly hashService: HashService,
  ) {}

  async recordEvent(params: RecordAuditEventParams): Promise<AuditChainEntity> {
    return this.dataSource.transaction(async (manager) => {
      await manager.query('SELECT pg_advisory_xact_lock($1)', [
        AUDIT_CHAIN_LOCK_KEY,
      ]);

      const repository = manager.getRepository(AuditChainEntity);
      const [previous] = await repository.find({
        order: { id: 'DESC' },
        take: 1,
      });

      const chainHash = previous?.actualHash ?? AUDIT_CHAIN_GENESIS_HASH;
      const timestamp = params.timestamp ?? new Date();
      const timestampIso = timestamp.toISOString();

      const chipher = await this.hashService.generateCiperHash({
        documentId: params.documentId,
        auditType: params.auditType,
        metadata: params.metadata ?? null,
        timestamp: timestampIso,
      });

      const actualHash = await this.hashService.generateChainedHash(
        params.documentId,
        chipher,
        chainHash,
        params.auditType,
        timestampIso,
      );

      const saved = await repository.save(
        repository.create({
          documentId: params.documentId,
          chipher,
          actualHash,
          chainHash,
          auditType: params.auditType,
          timestamp,
        }),
      );

      this.logger.log(
        `Fila de auditoría global #${saved.id} encadenada (auditType=${params.auditType}, documento=${params.documentId})`,
      );

      return saved;
    });
  }
}
