import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';

import { OrganizationEntity } from 'src/account/entities/organization.entity';
import { ApiKeyEntity } from 'src/api-key/entities/api-key.entity';
import { DocumentEntity } from 'src/document/entities/document.entity';

/**
 * Un `Idempotency-Key` ya usado al crear un documento por la API de integración.
 *
 * La fila se inserta DENTRO de la transacción que crea el documento y cobra el crédito: si dos
 * peticiones con la misma clave llegan a la vez, la segunda choca contra
 * `UQ_integration_idempotency_keys_organization_key` y su transacción entera se deshace —sin
 * documento ni crédito—; después se responde con el documento de la primera.
 *
 * La clave es por ORGANIZACIÓN y no por llave: rotar la llave a mitad de un reintento no debe
 * crear un segundo documento. `requestFingerprint` (SHA-256 del archivo y del payload) detecta la
 * misma clave reutilizada con otro contenido.
 */
@Entity('integration_idempotency_keys')
@Index(
  'UQ_integration_idempotency_keys_organization_key',
  ['organizationId', 'idempotencyKey'],
  { unique: true },
)
export class IntegrationIdempotencyKeyEntity {
  @PrimaryGeneratedColumn('uuid', {
    primaryKeyConstraintName: 'PK_integration_idempotency_keys',
  })
  id: string;

  @Column({ name: 'organization_id', type: 'uuid' })
  organizationId: string;

  @ManyToOne(() => OrganizationEntity, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'organization_id',
    foreignKeyConstraintName: 'FK_integration_idempotency_keys_organization_id',
  })
  organization?: OrganizationEntity;

  /** Llave con la que se hizo la primera petición; informativa (la clave es por organización). */
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

  /** SHA-256 hexadecimal del archivo y del payload de la primera petición. */
  @Column({ name: 'request_fingerprint', type: 'varchar', length: 64 })
  requestFingerprint: string;

  @Column({ name: 'document_id', type: 'uuid' })
  documentId: string;

  @ManyToOne(() => DocumentEntity, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'document_id',
    foreignKeyConstraintName: 'FK_integration_idempotency_keys_document_id',
  })
  document?: DocumentEntity;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
