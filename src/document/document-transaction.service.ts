import { Injectable } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { DocumentTransactionEntity } from './entities/document-transaction.entity';
import { HashService } from 'src/shared/hash/hash.service';

/**
 * Namespace fijo para el advisory lock de Postgres usado por registerSignature (distinto del
 * namespace de AuditChainService, que encadena globalmente — este encadena por documento).
 */
const DOCUMENT_TRANSACTION_LOCK_NAMESPACE = 445566;

/**
 * Registro de Transacciones (Document Transaction, ver diagrama ER-V2): bitácora de integridad
 * encadenada por documento, independiente de AuditService (Mongo, best-effort). Cada documento
 * arranca con un registro inicial (chainHash vacío); cada firma agrega un registro nuevo cuyo
 * chainHash es el actualHash del registro inmediato anterior — mismo criterio de encadenamiento
 * que ya usa AuditService, aplicado aquí a una tabla relacional propia para poder consultarse en
 * tiempo real junto con el resto del dominio de documentos (GET /document/:id).
 */
@Injectable()
export class DocumentTransactionService {
  constructor(
    @InjectRepository(DocumentTransactionEntity)
    private readonly documentTransactionRepository: Repository<DocumentTransactionEntity>,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly hashService: HashService,
  ) {}

  private repository(manager?: EntityManager) {
    return manager
      ? manager.getRepository(DocumentTransactionEntity)
      : this.documentTransactionRepository;
  }

  /**
   * Registro inicial al crear un documento — chainHash vacío (no hay registro previo que
   * encadenar). `actualHash` es el hash del archivo (originalHash) ya calculado por el caller.
   * `manager` opcional: cuando se crea dentro de una transacción más grande (ver
   * DocumentSignaturesService), pasar el `EntityManager` transaccional para que el INSERT corra
   * en la misma transacción y participe del rollback si algo más falla después.
   */
  async createInitial(
    documentId: string,
    actualHash: string,
    manager?: EntityManager,
  ): Promise<DocumentTransactionEntity> {
    const timeStamp = new Date();
    const chipher = await this.hashService.generateCiperHash({
      documentId,
      actualHash,
      chainHash: '',
      event: 'DOCUMENT_CREATED',
      timeStamp: timeStamp.toISOString(),
    });

    const repository = this.repository(manager);
    return repository.save(
      repository.create({
        documentId,
        collaboratorId: null,
        actualHash,
        chainHash: '',
        timeStamp,
        chipher,
      }),
    );
  }

  /**
   * Encadena un nuevo registro cuando un colaborador firma: el chainHash del registro nuevo es
   * el actualHash del registro inmediato anterior de ese mismo documento (ver docblock de
   * DocumentTransactionEntity). `signatureHash` identifica de forma estable la firma concreta
   * que se está encadenando (p. ej. el signedAt/id del colaborador).
   *
   * Bug corregido: "leer el último registro, calcular el hash, insertar" es una sección crítica
   * — sin serializarla, dos firmantes del MISMO documento firmando casi al mismo tiempo (posible
   * a propósito en un documento `isSequential=false`, donde cualquiera puede firmar ya, sin
   * esperar turno) podían leer el mismo "último" registro y encadenar dos filas nuevas al mismo
   * padre, bifurcando la cadena de ESE documento. `pg_advisory_xact_lock` (con hashtext(documentId)
   * como segunda clave, para no serializar documentos distintos entre sí) cierra esa ventana —
   * mismo criterio que AuditChainService usa para su cadena global.
   */
  async registerSignature(
    documentId: string,
    collaboratorId: string,
    signatureHash: string,
  ): Promise<DocumentTransactionEntity> {
    return this.dataSource.transaction(async (manager) => {
      await manager.query('SELECT pg_advisory_xact_lock($1, hashtext($2))', [
        DOCUMENT_TRANSACTION_LOCK_NAMESPACE,
        documentId,
      ]);

      const repository = manager.getRepository(DocumentTransactionEntity);
      const [previous] = await repository.find({
        where: { documentId },
        order: { timeStamp: 'DESC' },
        take: 1,
      });

      const chainHash = previous?.actualHash ?? '';
      const timeStamp = new Date();

      const actualHash = await this.hashService.generateRegistryHash({
        documentId,
        collaboratorId,
        signatureHash,
        chainHash,
        timeStamp: timeStamp.toISOString(),
      });

      const chipher = await this.hashService.generateCiperHash({
        documentId,
        collaboratorId,
        signatureHash,
        actualHash,
        chainHash,
        timeStamp: timeStamp.toISOString(),
      });

      return repository.save(
        repository.create({
          documentId,
          collaboratorId,
          actualHash,
          chainHash,
          timeStamp,
          chipher,
        }),
      );
    });
  }

  /** Historial completo de transacciones de un documento, en orden cronológico (para GET /document/:id). */
  async findAllForDocument(
    documentId: string,
  ): Promise<DocumentTransactionEntity[]> {
    return this.documentTransactionRepository.find({
      where: { documentId },
      order: { timeStamp: 'ASC' },
    });
  }
}
