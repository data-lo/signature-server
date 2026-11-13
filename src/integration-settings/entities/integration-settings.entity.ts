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
 * Reúne dos opciones con dueños distintos:
 * - `status`: interruptor administrativo (`ACTIVE`/`DISABLED`) que cambia un miembro con
 *   `API_KEY.MANAGE` en `PATCH /organizations/:organizationId/integration-settings` y que
 *   `OrganizationApiKeyGuard` consulta en cada petición.
 * - `webhooksEnabled`: si los procesos de firma creados por la API generan webhooks; lo cambia el
 *   sistema del cliente con su API key en `PATCH /integration/settings`.
 *
 * Cada actualización toca sólo su columna, así que cambiar una nunca reinicia la otra.
 *
 * - `UQ_integration_settings_organization_id` (restricción `UNIQUE` de la migración) garantiza una
 *   sola fila por organización; el alta inicial (`ensureInitialIntegrationSettings`) y ambas
 *   actualizaciones se apoyan en ella con `ON CONFLICT`. No se declara con `@Index`: la relación
 *   `OneToOne` ya hace la columna única para TypeORM.
 * - La fila nace `ACTIVE` y con `webhooksEnabled: false` al emitir la primera API key de la
 *   organización, o en la migración `CreateIntegrationSettings1784300000095` para las que ya tenían
 *   alguna. Pertenece a la organización, no a una llave: rotar o revocar la llave no la toca.
 * - Una organización sin fila nunca usó la integración: el guard la trata como `ACTIVE` y los
 *   webhooks como desactivados.
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

  /** Si los eventos de firma de los documentos creados por la API generan webhooks. */
  @Column({ name: 'webhooks_enabled', type: 'boolean', default: false })
  webhooksEnabled: boolean;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
