import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  OneToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { AccountEntity } from 'src/account/entities/account.entity';
import { PLAN_ID_ENUM } from '../enums/plan-id.enum';
import { SUBSCRIPTION_STATUS_ENUM } from '../enums/subscription-status.enum';

@Entity('account_subscriptions')
export class AccountSubscriptionEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'account_id', unique: true })
  accountId: string;

  @Column({ name: 'plan_id', type: 'enum', enum: PLAN_ID_ENUM, nullable: true })
  planId: PLAN_ID_ENUM | null;

  @Column({ name: 'stripe_customer_id', nullable: true })
  stripeCustomerId: string | null;

  @Column({ name: 'stripe_subscription_id', nullable: true })
  stripeSubscriptionId: string | null;

  @Column({
    name: 'status',
    type: 'enum',
    enum: SUBSCRIPTION_STATUS_ENUM,
    default: SUBSCRIPTION_STATUS_ENUM.INCOMPLETE,
  })
  status: SUBSCRIPTION_STATUS_ENUM;

  @Column({ name: 'current_period_end', type: 'timestamp', nullable: true })
  currentPeriodEnd: Date | null;

  @Column({ name: 'signing_enabled', default: false })
  signingEnabled: boolean;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;

  @OneToOne(() => AccountEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'account_id' })
  account: AccountEntity;
}
