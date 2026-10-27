import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';

import { ApiKeyEntity } from 'src/api-key/entities/api-key.entity';
import { DocumentEntity } from 'src/document/entities/document.entity';

/** En qué punto está la petición que usó la clave. */
export enum INTEGRATION_IDEMPOTENCY_STATUS_ENUM {
  /** Reservada: la petición está creando el documento. Todavía no hay `documentId`. */
  PROCESSING = 'PROCESSING',
  /** El documento se creó; `documentId` es el que se devuelve a cada repetición. */
  COMPLETED = 'COMPLETED',
}

/**
 * Un `Idempotency-Key` usado al crear un documento por la API de integración.
 *
 * El ciclo es reservar → completar:
 * 1. Antes de subir nada, la petición RESERVA la clave (`PROCESSING`, con una vigencia corta). Una
 *    segunda petición con la misma clave choca contra
 *    `UQ_integration_idempotency_keys_api_key_key` y responde sin subir el archivo ni crear nada.
 * 2. Dentro de la transacción que crea el documento y cobra el crédito, la reserva pasa a
 *    `COMPLETED` con su `documentId` y la retención larga. Si el alta falla, la reserva se borra y
 *    el cliente puede reintentar con la misma clave.
 *
 * `expiresAt` es a la vez el plazo de la reserva y la retención de la clave completada: vencida,
 * la clave se puede volver a usar. `requestHash` (SHA-256 del archivo y del payload) detecta la
 * misma clave reutilizada con otro contenido.
 */
@Entity('integration_idempotency_keys')
@Index(
  'UQ_integration_idempotency_keys_api_key_key',
  ['apiKeyId', 'idempotencyKey'],
  { unique: true },
)
@Check(
  'CHK_integration_idempotency_keys_completed_document',
  `"status" <> 'COMPLETED' OR "document_id" IS NOT NULL`,
)
export class IntegrationIdempotencyKeyEntity {
  @PrimaryGeneratedColumn('uuid', {
    primaryKeyConstraintName: 'PK_integration_idempotency_keys',
  })
  id: string;

  /** Llave con la que se usó la clave; la unicidad es por llave. */
  @Column({ name: 'api_key_id', type: 'uuid' })
  apiKeyId: string;

  @ManyToOne(() => ApiKeyEntity, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'api_key_id',
    foreignKeyConstraintName: 'FK_integration_idempotency_keys_api_key_id',
  })
  apiKey?: ApiKeyEntity;

  /** Valor del header `Idempotency-Key`, tal como lo mandó el cliente. */
  @Column({ name: 'idempotency_key', type: 'varchar', length: 255 })
  idempotencyKey: string;

  /** SHA-256 hexadecimal del archivo y del payload de la petición que reservó la clave. */
  @Column({ name: 'request_hash', type: 'varchar', length: 64 })
  requestHash: string;

  /** Documento creado; `null` mientras la clave está `PROCESSING`. */
  @Column({ name: 'document_id', type: 'uuid', nullable: true })
  documentId: string | null;

  @ManyToOne(() => DocumentEntity, { onDelete: 'CASCADE', nullable: true })
  @JoinColumn({
    name: 'document_id',
    foreignKeyConstraintName: 'FK_integration_idempotency_keys_document_id',
  })
  document?: DocumentEntity | null;

  @Column({
    type: 'enum',
    enum: INTEGRATION_IDEMPOTENCY_STATUS_ENUM,
  })
  status: INTEGRATION_IDEMPOTENCY_STATUS_ENUM;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  /** Fin de la reserva (`PROCESSING`) o de la retención (`COMPLETED`); vencida, la clave se libera. */
  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt: Date;
}
