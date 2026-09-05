import {
  Column,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { DocumentEntity } from 'src/document/entities/document.entity';
import { AUDIT_TYPE_ENUM } from '../enums/audit-type.enum';

/**
 * Ledger global de integridad, append-only: el `chainHash` de cada fila es el `actualHash` de la
 * fila con el MAX(id) global anterior, sin importar a qué documento pertenezca. Alterar o borrar una
 * fila histórica rompe la secuencia desde ese punto, detectable al recalcular la cadena.
 *
 * Distinto de `DocumentTransaction` y de `AuditService`/Mongo, que encadenan por documento.
 *
 * `id` es un entero autoincremental y no un uuid: es lo que hace de "MAX(id) global" una fuente de
 * verdad barata y sin ambigüedad para "la última fila".
 *
 * `documentId` es nullable con ON DELETE SET NULL: un documento en CREATED puede eliminarse, pero
 * la fila de auditoría ya encadenada nunca debe desaparecer con él —eso rompería la cadena para
 * siempre—. El contenido cifrado conserva el documentId original aunque la FK quede en null.
 */
@Entity('audit')
export class AuditChainEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ name: 'document_id', nullable: true })
  documentId: string | null;

  @ManyToOne(() => DocumentEntity, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'document_id' })
  document: DocumentEntity | null;

  /** Copia cifrada (AES-256-GCM) del contenido del evento — ver HashService.generateCiperHash. */
  @Column({ type: 'text' })
  chipher: string;

  /** SHA-256(documentId + chipher + chainHash + auditType + timestamp) — ver AuditChainService. */
  @Column({ name: 'actual_hash' })
  actualHash: string;

  /** El actualHash de la fila con el MAX(id) global inmediato anterior; Genesis Hash (64 ceros) si es la primera fila del sistema. */
  @Column({ name: 'chain_hash' })
  chainHash: string;

  @Column({ name: 'audit_type', type: 'enum', enum: AUDIT_TYPE_ENUM })
  auditType: AUDIT_TYPE_ENUM;

  @Column({ type: 'timestamp' })
  timestamp: Date;
}
