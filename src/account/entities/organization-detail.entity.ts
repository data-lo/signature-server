import { Column, Entity, JoinColumn, OneToOne, PrimaryColumn } from 'typeorm';
import { AccountEntity } from './account.entity';

@Entity('organization_details')
export class OrganizationDetailEntity {
  @PrimaryColumn('uuid', { name: 'account_id' })
  accountId: string;

  @Column({ name: 'name' })
  name: string;

  @OneToOne(() => AccountEntity, (account) => account.organizationDetail, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'account_id' })
  account: AccountEntity;
}
