import { Injectable } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { DocumentTransactionEntity } from './entities/document-transaction.entity';
import { HashService } from 'src/shared/hash/hash.service';

/**
 * Namespace fijo para el advisory lock de Postgres usado al encadenar (distinto del namespace de
 * AuditChainService, que encadena globalmente — este encadena por documento).
 */
const DOCUMENT_TRANSACTION_LOCK_NAMESPACE = 445566;

/**
 * Distingue el registro final del inicial, los dos que van sin `collaboratorId`, por su chainHash:
 * el inicial es el único de la cadena que no encadena con nada, así que el suyo es ''.
 */
export function isCompletionRecord(record: DocumentTransactionEntity): boolean {
  return record.collaboratorId === null && record.chainHash !== '';
}

/**
 * Mantiene la bitácora de integridad encadenada por documento, independiente de AuditService (Mongo,
 * best-effort). Cada documento arranca con un registro inicial de `chainHash` vacío y cada registro
 * nuevo encadena con el `actualHash` del anterior.
 *
 * Vive en una tabla relacional propia para poder consultarse en tiempo real junto con el resto del
 * dominio de documentos (`GET /document/:id`).
 *
 * **Qué se encadena depende del tipo de firma** (lo decide `DocumentEventsConsumer`):
 *
 * - **Firma simple**: un registro por firma. La rúbrica estampada no es prueba criptográfica por sí
 *   misma, así que la integridad de cada acto de firma vive en esta cadena.
 * - **Firma avanzada (FIEL)**: las firmas intermedias no generan registro, porque cada una ya lleva
 *   su evidencia criptográfica verificable en `CollaboratorEntity.advancedSignature` y duplicarla no
 *   agrega garantías. Sólo se agrega el registro final cuando termina el último firmante.
 *
 * En un documento mixto conviven ambas reglas.
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
   * Abre la cadena con el registro inicial al crear un documento: `chainHash` vacío, porque no hay
   * registro previo que encadenar, y `actualHash` es el hash del archivo ya calculado por el caller.
   *
   * `manager` es opcional: cuando se crea dentro de una transacción más grande, pasar el
   * `EntityManager` transaccional hace que el INSERT participe del rollback si algo falla después.
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
   * Encadena un nuevo registro cuando un colaborador firma con **firma simple**: el chainHash del
   * registro nuevo es el actualHash del registro inmediato anterior de ese mismo documento (ver
   * docblock de DocumentTransactionEntity). `signatureHash` identifica de forma estable la firma
   * concreta que se está encadenando (p. ej. el signedAt/id del colaborador).
   */
  async registerSignature(
    documentId: string,
    collaboratorId: string,
    signatureHash: string,
  ): Promise<DocumentTransactionEntity> {
    return this.appendChained(documentId, (chainHash, timeStamp) => ({
      collaboratorId,
      hashPayload: {
        documentId,
        collaboratorId,
        signatureHash,
        chainHash,
        timeStamp: timeStamp.toISOString(),
      },
      event: 'COLLABORATOR_SIGNED',
    }));
  }

  /**
   * Cierra la cadena con el registro final, cuando el ÚLTIMO firmante completó su firma y el
   * documento tiene al menos una firma avanzada. Va sin `collaboratorId` —como el inicial— porque
   * representa al documento completo y lo liga al hash del PDF final ya estampado (`signedHash`).
   *
   * Es idempotente: si el documento ya tiene su registro final lo devuelve en vez de encadenar otro.
   * La comprobación corre dentro de la misma sección crítica que la inserción, así que dos eventos
   * concurrentes no pueden crear dos registros finales.
   */
  async registerCompletion(
    documentId: string,
    signedHash: string,
  ): Promise<DocumentTransactionEntity> {
    return this.appendChained(
      documentId,
      (chainHash, timeStamp) => ({
        collaboratorId: null,
        hashPayload: {
          documentId,
          signedHash,
          chainHash,
          timeStamp: timeStamp.toISOString(),
        },
        event: 'DOCUMENT_COMPLETED',
      }),
      (existing) => existing.find(isCompletionRecord),
    );
  }

  /**
   * Serializa la sección crítica que comparten todos los registros encadenados: leer el último,
   * calcular el hash e insertar.
   *
   * Sin serializar esa secuencia, dos firmantes del MISMO documento firmando casi a la vez —posible
   * a propósito cuando `isSequential=false`— podían leer el mismo "último" registro y encadenar dos
   * filas al mismo padre, bifurcando la cadena de ese documento. `pg_advisory_xact_lock`, con
   * `hashtext(documentId)` como segunda clave para no serializar documentos distintos entre sí,
   * cierra esa ventana. Mismo criterio que `AuditChainService` en su cadena global.
   */
  private async appendChained(
    documentId: string,
    build: (
      chainHash: string,
      timeStamp: Date,
    ) => {
      collaboratorId: string | null;
      hashPayload: Record<string, unknown>;
      event: string;
    },
    findExisting?: (
      records: DocumentTransactionEntity[],
    ) => DocumentTransactionEntity | undefined,
  ): Promise<DocumentTransactionEntity> {
    return this.dataSource.transaction(async (manager) => {
      await manager.query('SELECT pg_advisory_xact_lock($1, hashtext($2))', [
        DOCUMENT_TRANSACTION_LOCK_NAMESPACE,
        documentId,
      ]);

      const repository = manager.getRepository(DocumentTransactionEntity);
      const records = await repository.find({
        where: { documentId },
        order: { timeStamp: 'DESC' },
      });

      const alreadyRegistered = findExisting?.(records);
      if (alreadyRegistered) {
        return alreadyRegistered;
      }

      const chainHash = records[0]?.actualHash ?? '';
      const timeStamp = new Date();
      const { collaboratorId, hashPayload, event } = build(
        chainHash,
        timeStamp,
      );

      const actualHash =
        await this.hashService.generateRegistryHash(hashPayload);
      const chipher = await this.hashService.generateCiperHash({
        ...hashPayload,
        actualHash,
        event,
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
