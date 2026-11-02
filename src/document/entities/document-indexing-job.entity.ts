import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { DocumentEntity } from './document.entity';
import { DOCUMENT_INDEXING_STATUS_ENUM } from '../enum/document-indexing-status.enum';

/**
 * Trabajo de indexación de un documento: cada envío al indexador y lo que éste respondió.
 *
 * Separa el estado técnico de la indexación de `DocumentEntity`, cuyo `isIndexable` conserva su
 * propósito (si el documento debe incluirse en la búsqueda). Un documento puede acumular varios
 * trabajos, por eso la relación es `ManyToOne`.
 *
 * `documentId` y `document` comparten la columna física `document_id`.
 *
 * Se crea en `PENDING` dentro de la transacción que crea el documento y encola `document.index`
 * (ver `DocumentIndexRequestService.enqueue`), así que nunca existe un job sin su evento ni al revés.
 * La tabla la crea la migración `CreateDocumentIndexingJobs`.
 */
@Entity('document_indexing_jobs')
@Index('IDX_document_indexing_jobs_document', ['documentId'])
export class DocumentIndexingJobEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'document_id', type: 'uuid' })
  documentId: string;

  /** `CASCADE` como el resto de las tablas hijas de `documents`: el job no vive sin su documento. */
  @ManyToOne(() => DocumentEntity, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'document_id',
    // El mismo nombre que la migración, para que `schema:log` no proponga recrearla.
    foreignKeyConstraintName: 'FK_document_indexing_jobs_document_id',
  })
  document: DocumentEntity;

  /** Id que asigna el indexador; `null` hasta que acepta el trabajo. */
  @Column({ name: 'external_job_id', type: 'varchar', nullable: true })
  externalJobId: string | null;

  @Column({
    type: 'enum',
    enum: DOCUMENT_INDEXING_STATUS_ENUM,
    default: DOCUMENT_INDEXING_STATUS_ENUM.PENDING,
  })
  status: DOCUMENT_INDEXING_STATUS_ENUM;

  @Column({ name: 'attempt_count', type: 'int', default: 0 })
  attemptCount: number;

  /** Cuándo el indexador aceptó el trabajo (`RECEIVED`). */
  @Column({ name: 'received_at', type: 'timestamptz', nullable: true })
  receivedAt: Date | null;

  /** Cuándo terminó, con éxito (`INDEXED`) o con error (`FAILED`). */
  @Column({ name: 'completed_at', type: 'timestamptz', nullable: true })
  completedAt: Date | null;

  @Column({ name: 'error', type: 'text', nullable: true })
  error: string | null;

  /** Datos variables del indexador, como `duplicate` o el estado original del proveedor. */
  @Column({ name: 'metadata', type: 'jsonb', nullable: true })
  metadata: Record<string, unknown> | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
