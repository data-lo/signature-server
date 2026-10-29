import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  JoinTable,
  ManyToMany,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { AccountEntity } from 'src/account/entities/account.entity';
import { OrganizationEntity } from 'src/account/entities/organization.entity';
import { PermissionEntity } from 'src/roles/entities/permission.entity';
import { ApiKeyStatusEnum } from '../enums/api-key-status.enum';

/**
 * La API key de una organización.
 *
 * Una organización tiene a lo sumo una llave `ACTIVE` (`uq_api_keys_one_active_per_organization`,
 * índice único parcial); las anteriores se quedan como `REVOKED` para historial y auditoría, así
 * que rotar la llave es revocar la vigente y emitir otra.
 *
 * El secreto nunca se guarda: sólo su hash (`secretHash`). `publicId` identifica la llave sin
 * exponerlo y `keyPrefix` es lo que se le muestra al administrador para reconocerla.
 *
 * Los permisos reutilizan el catálogo de `permissions` (el mismo de los roles) a través de la tabla
 * pivote `api_key_permissions`; no hay un catálogo de scopes propio.
 *
 * Restricciones de la base (`CreateApiKeys1784300000077`):
 * - `CHK_api_keys_revocation`: una llave `ACTIVE` no tiene datos de revocación y una `REVOKED`
 *   siempre tiene `revokedAt`. `revokedByAccountId` puede faltar en una revocada: no toda baja la
 *   hace una membresía.
 * - `CHK_api_keys_expiry`: si vence, vence después de crearse.
 */
@Entity('api_keys')
@Index('UQ_api_keys_public_id', ['publicId'], { unique: true })
@Index('uq_api_keys_one_active_per_organization', ['organizationId'], {
  unique: true,
  where: `"status" = 'ACTIVE'`,
})
@Index('IDX_api_keys_organization_id_status', ['organizationId', 'status'])
@Check(
  'CHK_api_keys_revocation',
  `("status" = 'ACTIVE' AND "revoked_at" IS NULL AND "revoked_by_account_id" IS NULL) OR ("status" = 'REVOKED' AND "revoked_at" IS NOT NULL)`,
)
@Check(
  'CHK_api_keys_expiry',
  `"expires_at" IS NULL OR "expires_at" > "created_at"`,
)
export class ApiKeyEntity {
  @PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'PK_api_keys' })
  id: string;

  @Column({ name: 'organization_id', type: 'uuid' })
  organizationId: string;

  /** `CASCADE`, igual que `accounts.organization_id`: borrar la organización borra sus llaves. */
  @ManyToOne(() => OrganizationEntity, (organization) => organization.apiKeys, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({
    name: 'organization_id',
    foreignKeyConstraintName: 'FK_api_keys_organization_id',
  })
  organization: OrganizationEntity;

  /**
   * La membresía (`accounts.id`) que emitió la llave, o `null` si la emitió la plataforma (el
   * aprovisionamiento interno, `AddPlatformProvisioning1784300000086`). Una llave de plataforma no
   * actúa en nombre de ninguna membresía: `OrganizationApiKeyGuard` la deja sin actor.
   */
  @Column({ name: 'created_by_account_id', type: 'uuid', nullable: true })
  createdByAccountId: string | null;

  /**
   * `NO ACTION`: la membresía que emitió una llave no se puede borrar mientras la llave exista, para
   * no perder la autoría. Las membresías se dan de baja con `is_active = false`, no se borran; y al
   * borrar la organización, la llave cae en la misma cascada.
   */
  @ManyToOne(() => AccountEntity, (account) => account.createdApiKeys, {
    nullable: true,
    onDelete: 'NO ACTION',
  })
  @JoinColumn({
    name: 'created_by_account_id',
    foreignKeyConstraintName: 'FK_api_keys_created_by_account_id',
  })
  createdByAccount: AccountEntity | null;

  /** Identificador público y único de la llave; no contiene el secreto. */
  @Column({ name: 'public_id' })
  publicId: string;

  /** Prefijo visible con el que el administrador reconoce la llave; no contiene el secreto. */
  @Column({ name: 'key_prefix' })
  keyPrefix: string;

  /** Hash del secreto; el secreto en claro sólo se entrega al emitir la llave. */
  @Column({ name: 'secret_hash' })
  secretHash: string;

  /** Nombre administrativo con el que se identifica la llave en la interfaz. */
  @Column()
  name: string;

  @Column({
    type: 'enum',
    enum: ApiKeyStatusEnum,
    enumName: 'api_key_status_enum',
    default: ApiKeyStatusEnum.ACTIVE,
  })
  status: ApiKeyStatusEnum;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  /** Último uso exitoso; `null` si la llave nunca se ha usado. */
  @Column({ name: 'last_used_at', type: 'timestamptz', nullable: true })
  lastUsedAt: Date | null;

  /** Vencimiento opcional; `null` si la llave no vence. */
  @Column({ name: 'expires_at', type: 'timestamptz', nullable: true })
  expiresAt: Date | null;

  /** Momento de la revocación; `null` mientras la llave esté `ACTIVE`. */
  @Column({ name: 'revoked_at', type: 'timestamptz', nullable: true })
  revokedAt: Date | null;

  /** La membresía que revocó la llave; `null` si sigue vigente o si no la revocó una membresía. */
  @Column({ name: 'revoked_by_account_id', type: 'uuid', nullable: true })
  revokedByAccountId: string | null;

  /** `NO ACTION`, por el mismo motivo que `createdByAccount`. */
  @ManyToOne(() => AccountEntity, (account) => account.revokedApiKeys, {
    nullable: true,
    onDelete: 'NO ACTION',
  })
  @JoinColumn({
    name: 'revoked_by_account_id',
    foreignKeyConstraintName: 'FK_api_keys_revoked_by_account_id',
  })
  revokedByAccount: AccountEntity | null;

  /**
   * Permisos del catálogo existente concedidos a la llave.
   *
   * En `api_key_permissions`, borrar la llave borra sus filas (`CASCADE`, aquí) y un permiso
   * asignado a alguna llave no se puede borrar (`RESTRICT`, en `PermissionEntity.apiKeys`).
   */
  @ManyToMany(() => PermissionEntity, (permission) => permission.apiKeys, {
    onDelete: 'CASCADE',
    onUpdate: 'NO ACTION',
  })
  @JoinTable({
    name: 'api_key_permissions',
    joinColumn: {
      name: 'api_key_id',
      referencedColumnName: 'id',
      foreignKeyConstraintName: 'FK_api_key_permissions_api_key_id',
    },
    inverseJoinColumn: {
      name: 'permission_id',
      referencedColumnName: 'id',
      foreignKeyConstraintName: 'FK_api_key_permissions_permission_id',
    },
  })
  permissions: PermissionEntity[];
}
