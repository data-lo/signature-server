import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  OneToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

import { OrganizationEntity } from 'src/account/entities/organization.entity';

import { INTEGRATION_STATUS_ENUM } from '../enums/integration-status.enum';

/**
 * Configuración general de la API de integración de una organización.
 *
 * ```text
 * organizations 1 ───── 0..1 integration_settings
 * organizations 1 ───── 0..N api_keys
 * ```
 *
 * - `UQ_integration_settings_organization_id` (restricción `UNIQUE` de la migración) garantiza una
 *   sola fila por organización; tanto el alta inicial (`ensureInitialIntegrationSettings`) como la
 *   actualización administrativa se apoyan en ella con `ON CONFLICT`. No se declara con `@Index`:
 *   la relación `OneToOne` ya hace la columna única para TypeORM.
 * - La fila nace `ACTIVE` al emitir la primera API key de la organización, o en la migración
 *   `CreateIntegrationSettings1784300000095` para las que ya tenían alguna.
 * - Una organización sin fila nunca usó la integración; el guard la trata como `ACTIVE`.
 * - Se borra con la organización (`ON DELETE CASCADE`).
 */
@Entity('integration_settings')
export class IntegrationSettingsEntity {
  @PrimaryGeneratedColumn('uuid', {
    primaryKeyConstraintName: 'PK_integration_settings',
  })
  id: string;

  @Column({ name: 'organization_id', type: 'uuid' })
  organizationId: string;

  @OneToOne(
    () => OrganizationEntity,
    (organization) => organization.integrationSettings,
    { onDelete: 'CASCADE' },
  )
  @JoinColumn({
    name: 'organization_id',
    foreignKeyConstraintName: 'FK_integration_settings_organization_id',
  })
  organization?: OrganizationEntity;

  @Column({
    type: 'enum',
    enum: INTEGRATION_STATUS_ENUM,
    enumName: 'integration_status_enum',
    default: INTEGRATION_STATUS_ENUM.ACTIVE,
  })
  status: INTEGRATION_STATUS_ENUM;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
