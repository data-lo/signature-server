import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { DocumentEntity } from 'src/document/entities/document.entity';

/**
 * Respuesta del Seal Service para un documento firmado con firma avanzada (ver
 * `SealClientService`). Se guarda como evidencia: el sello de tiempo y la constancia NOM-151 son
 * lo que acredita ante terceros cuándo existió el conjunto de firmas.
 *
 * `hashHex` se sube a columna propia porque es el identificador con el que el Seal Service
 * reconstruye y verifica el sello; el resto de la respuesta se conserva íntegra en `response`
 * (jsonb) en vez de desmenuzarse en columnas, porque la historia dejó pendiente definir qué se
 * almacena exactamente ("se agregará el detalle abajo en un comentario"). Guardar el payload
 * completo evita perder información antes de que esa decisión exista; cuando se defina, se
 * pueden promover campos a columnas sin haber tirado nada.
 */
@Entity('document_seals')
export class DocumentSealEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** Un sello por documento: el Seal Service se llama una sola vez, al completarse la firma. */
  @Index({ unique: true })
  @Column({ name: 'document_id' })
  documentId: string;

  @ManyToOne(() => DocumentEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'document_id' })
  document: DocumentEntity;

  /** Hash canónico calculado por el Seal Service sobre el conjunto de firmas. */
  @Column({ name: 'hash_hex' })
  hashHex: string;

  /** Respuesta completa del Seal Service, tal cual llegó. */
  @Column({ type: 'jsonb' })
  response: Record<string, unknown>;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
