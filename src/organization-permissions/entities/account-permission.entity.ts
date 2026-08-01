import {
  Column,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';
import { AccountEntity } from 'src/account/entities/account.entity';
import { OrganizationPermissionEntity } from './organization-permission.entity';

/**
 * Junction table de asignación: qué permisos del catálogo (`organization_permissions`) tiene
 * asignados un miembro (`accounts.id`). Nombre deliberadamente distinto de `role_permissions`
 * (el junction del motor de RBAC en `src/roles/`) para no sugerir ninguna relación entre ambos
 * sistemas — esta asignación es directa cuenta↔permiso, sin pasar por Role.
 */
@Entity('account_permissions')
@Unique(['accountId', 'organizationPermissionId'])
export class AccountPermissionEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'account_id' })
  accountId: string;

  @ManyToOne(() => AccountEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'account_id' })
  account: AccountEntity;

  @Column({ name: 'organization_permission_id' })
  organizationPermissionId: string;

  @ManyToOne(() => OrganizationPermissionEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'organization_permission_id' })
  organizationPermission: OrganizationPermissionEntity;
}
