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

  /**
   * SHA-256 (hex, 64 caracteres) del XML de auditoría del documento armado SIN `generatedAt`, con
   * toda la evidencia ya completa: la constancia y el PDF final con su hoja actualizada.
   *
   * Lo escribe la fase `UPDATING_EVIDENCE_PDF` del trabajo de sellado
   * (`RecordVerificationRecordDigestUseCase`). Es la huella del expediente: si se vuelve a armar
   * con la misma evidencia, el digest coincide; si cambió un byte, no.
   *
   * Nullable: entre que se guarda la constancia y se termina el PDF final todavía no existe, y los
   * sellos anteriores a esta columna no lo tienen.
   */
  @Column({
    name: 'verification_record_digest',
    type: 'varchar',
    length: 64,
    nullable: true,
  })
  verificationRecordDigest: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
