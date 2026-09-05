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
 * Encadena eventos sobre TODA la base de datos: el `chainHash` de cada fila nueva es el
 * `actualHash` de la fila con el MAX(id) global anterior, sin importar el documento —a diferencia
 * de `DocumentTransactionService`, que encadena dentro de uno solo.
 *
 * `recordEvent` se invoca desde consumers de Kafka y nunca síncronamente desde el flujo HTTP, para
 * que la cadena no agregue latencia a la respuesta ni pueda tumbar la transacción principal.
 *
 * Procesa estrictamente en serie: "leer el MAX(id), calcular el hash, insertar" es una sección
 * crítica, y sin serializarla dos eventos casi simultáneos —dos consumers, dos particiones—
 * encadenarían al mismo padre y bifurcarían la cadena. `pg_advisory_xact_lock` la serializa en
 * Postgres y no sólo en memoria de este proceso, así que la garantía se sostiene con varias
 * instancias contra la misma base. Al ser transaccional, Postgres lo libera solo al commit o
 * rollback, sin riesgo de dejarlo tomado si el proceso truena.
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
