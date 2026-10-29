import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';
import { OrganizationEntity } from 'src/account/entities/organization.entity';

/**
 * Catálogo de permisos administrativos por organización (ver historia [STORY] Configuración de
 * catálogo de permisos y asignación por usuario). Deliberadamente distinto del motor de RBAC ya
 * existente en `src/roles/` (RoleEntity → RolePermissionEntity → PermissionEntity, tuplas
 * recurso+acción que sí gobiernan la autorización real) — este catálogo es solo una lista de
 * nombres administrada por el ADMIN de la organización, sin efecto sobre la autorización de
 * ningún otro endpoint. Un mismo nombre no puede repetirse dentro de la misma organización.
 */
@Entity('organization_permissions')
@Unique(['organizationId', 'name'])
export class OrganizationPermissionEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'organization_id' })
  organizationId: string;

  @ManyToOne(() => OrganizationEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'organization_id' })
  organization: OrganizationEntity;

  @Column()
  name: string;

  @Column({ name: 'is_active', default: true })
  isActive: boolean;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
