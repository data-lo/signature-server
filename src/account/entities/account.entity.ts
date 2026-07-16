import {
  Column,
  CreateDateColumn,
  Entity,
  OneToMany,
  OneToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { ACCOUNT_TYPE_ENUM } from '../enums/account-type.enum';
import { OrganizationDetailEntity } from './organization-detail.entity';
import { AccountMemberEntity } from './account-member.entity';

@Entity('accounts')
export class AccountEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'name' })
  name: string;

  @Column({ name: 'type', type: 'enum', enum: ACCOUNT_TYPE_ENUM })
  type: ACCOUNT_TYPE_ENUM;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @OneToOne(
    () => OrganizationDetailEntity,
    (organizationDetail) => organizationDetail.account,
  )
  organizationDetail: OrganizationDetailEntity;

  @OneToMany(() => AccountMemberEntity, (member) => member.account)
  members: AccountMemberEntity[];
}
