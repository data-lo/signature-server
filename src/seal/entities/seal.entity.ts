import { DocumentEntity } from 'src/document/entities/document.entity';

import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  OneToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export interface TimestampEvidence {
  isValid: boolean;
  processedHash: string;
  tokenBase64: string;
  evidenceId: string;
}

export interface Nom151Evidence {
  isValid: boolean;
  processedHash: string;
  tokenBase64: string;
  evidenceId: string;
  certificatePdfBase64: string;
}

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

  @Column({ name: 'nom151_evidence', type: 'jsonb' })
  nom151Evidence: Nom151Evidence;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
