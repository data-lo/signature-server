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
import { ACCOUNT_MEMBER_ROLE_ENUM } from '../enums/account-member-role.enum';

@Entity('account_members')
@Unique(['accountId', 'userId'])
export class AccountMemberEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'account_id' })
  accountId: string;

  @Column({ name: 'user_id' })
  userId: string;

  @Column({
    name: 'role',
    type: 'enum',
    enum: ACCOUNT_MEMBER_ROLE_ENUM,
    array: true,
  })
  role: ACCOUNT_MEMBER_ROLE_ENUM[];

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
