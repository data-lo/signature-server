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
 * Ledger global de integridad (ver diagrama ER-V2, entidad "audit" — distinta de
 * DocumentTransaction, que encadena solo dentro de un mismo documento, y de AuditService/Mongo,
 * que también encadena por documento). Aquí el encadenamiento es sobre TODA la base de datos:
 * el chainHash de cada fila nueva es el actualHash de la fila con el MAX(id) global anterior,
 * sin importar a qué documento pertenezca — un Append-Only Ledger estilo blockchain para toda
 * la instancia. Alterar o borrar una fila histórica rompe la secuencia a partir de ese punto,
 * detectable recalculando la cadena.
 *
 * `id` es un entero autoincremental (no uuid, a propósito — ver diagrama): es lo que permite
 * "MAX(id) global" como fuente de verdad barata y sin ambigüedad para "la última fila".
 *
 * `documentId` es nullable con ON DELETE SET NULL (ver migración): un documento en estatus
 * CREATED puede eliminarse (ver DocumentService.remove()), pero la fila de auditoría que ya
 * quedó encadenada NUNCA debe desaparecer con él — eso rompería la cadena para siempre. El
 * contenido cifrado (`chipher`) conserva el documentId original aunque la FK quede en null.
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
