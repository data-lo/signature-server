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

/**
 * Configuración de la API de integración de una organización. Hoy su única opción es si se envían
 * webhooks de los procesos de firma creados por la API.
 *
 * ```text
 * organizations 1 ───── 0..1 integration_settings
 * ```
 *
 * - Pertenece a la organización, no a una API key: rotar o revocar la llave no la toca.
 * - `UQ_integration_settings_organization_id` (restricción `UNIQUE` de la migración) admite una sola
 *   fila por organización; la actualización se apoya en ella con `ON CONFLICT`. No se declara con
 *   `@Index`: la relación `OneToOne` ya hace la columna única para TypeORM.
 * - Sin fila, la organización se comporta como `webhooksEnabled: false`. La fila se crea con el
 *   primer `PATCH /integration/settings`.
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

  @OneToOne(() => OrganizationEntity, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'organization_id',
    foreignKeyConstraintName: 'FK_integration_settings_organization_id',
  })
  organization?: OrganizationEntity;

  /** Si los eventos de firma de los documentos creados por la API generan webhooks. */
  @Column({ name: 'webhooks_enabled', type: 'boolean', default: false })
  webhooksEnabled: boolean;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
