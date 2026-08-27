import { DocumentEntity } from 'src/document/entities/document.entity';
import type { IntegrityEvidence } from '../interfaces/integrity-evidence.interface';
import type { TimestampEvidence } from '../interfaces/timestamp-evidence.interface';

import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  OneToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity('document_seals')
export class SealEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'document_id', type: 'uuid', unique: true })
  documentId: string;

  @OneToOne(() => DocumentEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'document_id' })
  document: DocumentEntity;

  @Column({ name: 'signature_hash', type: 'varchar' })
  signatureHash: string;

  @Column({ name: 'canonical_payload', type: 'text' })
  canonicalPayload: string;

  @Column({ name: 'timestamp_evidence', type: 'jsonb' })
  timestampEvidence: TimestampEvidence;

  @Column({ name: 'integrity_evidence', type: 'jsonb' })
  integrityEvidence: IntegrityEvidence;

  /**
   * Momento en que el PSC emitió la constancia (`sealedAt` de la respuesta de Seal Service).
   *
   * No es lo mismo que `createdAt`: ese es cuándo insertamos la fila. La hoja de evidencia rotula
   * este valor como "EMITIDO" en la tabla de la Constancia de Conservación (NOM-151), y para un
   * documento legal la diferencia importa.
   *
   * Nullable porque las filas selladas antes de existir esta columna no lo tienen.
   */
  @Column({ name: 'sealed_at', type: 'timestamptz', nullable: true })
  sealedAt: Date | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
