import { DocumentEntity } from 'src/document/entities/document.entity';
import type { IntegritySeal } from '../interfaces/integrity-seal.interface';
import type { TimestampSeal } from '../interfaces/timestamp-seal.interface';

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

  @Column({ name: 'timestamp_seal', type: 'jsonb' })
  timestampSeal: TimestampSeal;

  @Column({ name: 'integrity_seal', type: 'jsonb' })
  integritySeal: IntegritySeal;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
