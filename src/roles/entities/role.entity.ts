import {
  Column,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { OrganizationEntity } from 'src/account/entities/organization.entity';

@Entity('roles')
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
}
