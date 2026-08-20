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

  /**
   * Bug corregido: estas dos columnas se declaraban como `timestamp_seal`/`integrity_seal`, pero
   * la migración que crea la tabla (`CreateDocumentSeals1784300000025`) las llama
   * `timestamp_evidence`/`nom151_evidence` — con los nombres viejos, el primer INSERT de un sello
   * fallaba contra la base real ("column does not exist"). Se alinean con la migración, que es la
   * que gobierna el esquema desplegado; los nombres de las propiedades TS no cambian.
   */
  @Column({ name: 'timestamp_evidence', type: 'jsonb' })
  timestampSeal: TimestampSeal;

  @Column({ name: 'nom151_evidence', type: 'jsonb' })
  integritySeal: IntegritySeal;

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
