import {
  Column,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';
import { AccountEntity } from './account.entity';
import { UserEntity } from 'src/user/entities/user.entity';
import { RoleEntity } from 'src/roles/entities/role.entity';

@Entity('account_members')
@Unique(['accountId', 'userId'])
export class AccountMemberEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'account_id' })
  accountId: string;

  @Column({ name: 'user_id' })
  userId: string;

  /** NULL solo si a la membresía todavía no se le asignó un rol (reservado para un futuro flujo de invitación). */
  @Column({ name: 'role_id', nullable: true })
  roleId: string | null;

  @ManyToOne(() => RoleEntity, { nullable: true })
  @JoinColumn({ name: 'role_id' })
  role: RoleEntity | null;

  @Column({ name: 'position', nullable: true })
  position: string | null;

  @Column({ default: true, name: 'is_active' })
  isActive: boolean;

  @ManyToOne(() => AccountEntity, (account) => account.members, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'account_id' })
  account: AccountEntity;

  @ManyToOne(() => UserEntity, (user) => user.accountMemberships)
  @JoinColumn({ name: 'user_id' })
  user: UserEntity;
}
