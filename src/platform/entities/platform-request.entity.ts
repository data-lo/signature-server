import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * Un `Idempotency-Key` ya usado para aprovisionar una cuenta provisional Enterprise, con todo lo
 * que creó (migración `1784300000086`).
 *
 * Se escribe al final de la MISMA transacción que crea el usuario, la organización, el perfil, los
 * créditos y la llave, así que existe si y sólo si el aprovisionamiento se confirmó: no hay estado
 * "en curso". Dos peticiones simultáneas con la misma clave se serializan con un bloqueo asesor de
 * la transacción (`ProvisionProvisionalEnterpriseAccountUseCase`), y la segunda encuentra esta fila.
 *
 * Las referencias son `CASCADE`: borrar la organización (o el usuario) libera la clave.
 */
@Entity('platform_provisioning_requests')
@Index(
  'UQ_platform_provisioning_requests_idempotency_key',
  ['idempotencyKey'],
  { unique: true },
)
@Check(
  'CHK_platform_provisioning_requests_documents_granted',
  '"documents_granted" > 0',
)
export class PlatformRequestEntity {
  @PrimaryGeneratedColumn('uuid', {
    primaryKeyConstraintName: 'PK_platform_provisioning_requests',
  })
  id: string;

  /** Valor del header `Idempotency-Key`, tal como lo mandó el operador. */
  @Column({ name: 'idempotency_key', type: 'varchar', length: 255 })
  idempotencyKey: string;

  /** SHA-256 hexadecimal del body; detecta la misma clave reutilizada con otros datos. */
  @Column({ name: 'request_hash', type: 'varchar', length: 64 })
  requestHash: string;

  @Column({ name: 'organization_id', type: 'uuid' })
  organizationId: string;

  /** Membresía OWNER del propietario en la organización. */
  @Column({ name: 'organization_account_id', type: 'uuid' })
  organizationAccountId: string;

  @Column({ name: 'owner_user_id', type: 'uuid' })
  ownerUserId: string;

  /** Cuenta personal del propietario. */
  @Column({ name: 'owner_account_id', type: 'uuid' })
  ownerAccountId: string;

  @Column({ name: 'billing_profile_id', type: 'uuid' })
  billingProfileId: string;

  /** La llave emitida. Su secreto no está aquí ni en ningún otro lado. */
  @Column({ name: 'api_key_id', type: 'uuid' })
  apiKeyId: string;

  @Column({ name: 'documents_granted', type: 'integer' })
  documentsGranted: number;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
