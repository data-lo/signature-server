import {
  Column,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { AccountEntity } from 'src/account/entities/account.entity';

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

  @ManyToOne(() => AccountEntity, { nullable: true, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'organization_id' })
  organization: AccountEntity | null;
}
