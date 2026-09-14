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
 * Único por `(organizationId, name)` (ver migración `AddCreatedAtAndUniqueNameToRoles`): protege
 * a los roles custom de una organización de nombres duplicados. No afecta a ADMIN/MEMBER —
 * comparten `organizationId: null`, y Postgres trata cada NULL como distinto en un UNIQUE
 * multi-columna.
 */
@Entity('roles')
@Unique(['organizationId', 'name'])
export class RoleEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'name' })
  name: string;

  /** Roles del sistema (ADMIN, MEMBER) vienen del seed y no pertenecen a ninguna organización (organizationId = NULL). */
  @Column({ name: 'is_system_role', default: false })
  isSystemRole: boolean;

  /** NULL para roles del sistema; distinto de NULL para un futuro rol custom definido por una organización. */
  @Column({ name: 'organization_id', nullable: true })
  organizationId: string | null;

  /** Significado de negocio por definir (ver migración AddVisibilityToRoles) — aterrizada sin enforcement todavía. */
  @Column({ default: 0 })
  visibility: number;

  @ManyToOne(() => OrganizationEntity, { nullable: true, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'organization_id' })
  organization: OrganizationEntity | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
