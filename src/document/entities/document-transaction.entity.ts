import {
  Column,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { DocumentEntity } from './document.entity';
import { CollaboratorEntity } from './collaborator.entity';

/**
 * Bitácora de integridad encadenada por documento (ver diagrama ER-V2, entidad "Document
 * Transaction"). Se inserta un registro inicial al crear el documento (chainHash vacío); cada
 * firma de un colaborador agrega un nuevo registro cuyo chainHash es el actualHash del registro
 * inmediato anterior de ese mismo documento — mismo criterio de encadenamiento que ya usa
 * AuditService (ver HashService.generateRegistryHash/generateCiperHash).
 */
@Entity('document_transactions')
export class DocumentTransactionEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'document_id' })
  documentId: string;

  @ManyToOne(() => DocumentEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'document_id' })
  document: DocumentEntity;

  /** NULL en el registro inicial de creación; poblado cuando el registro corresponde a la firma de un colaborador. */
  @Column({ name: 'collaborator_id', nullable: true })
  collaboratorId: string | null;

  @ManyToOne(() => CollaboratorEntity, { nullable: true, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'collaborator_id' })
  collaborator: CollaboratorEntity | null;

  /** Hash unidireccional (SHA-256) del contenido de este registro — ver HashService.generateRegistryHash. */
  @Column({ name: 'actual_hash' })
  actualHash: string;

  /** Encadena con el actualHash del registro inmediato anterior del mismo documento; '' en el registro inicial. */
  @Column({ name: 'chain_hash', default: '' })
  chainHash: string;

  @Column({ name: 'time_stamp' })
  timeStamp: Date;

  /** Copia cifrada (AES-256-GCM, bidireccional) del contenido de este registro — ver HashService.generateCiperHash/reverseCiperHash. */
  @Column({ type: 'text' })
  chipher: string;
}
