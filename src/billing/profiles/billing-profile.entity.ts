import { AccountEntity } from 'src/account/entities/account.entity';
import { OrganizationEntity } from 'src/account/entities/organization.entity';
import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  OneToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { BILLING_PROFILE_STATUS_ENUM } from '../enums/billing-profile-status.enum';
import { PlanEntity } from '../catalog/plan.entity';

@Entity('billing_profiles')
@Check(
  'CHK_billing_profiles_exactly_one_owner',
  '("personal_account_id" IS NOT NULL AND "organization_id" IS NULL) OR ("personal_account_id" IS NULL AND "organization_id" IS NOT NULL)',
)
export class BillingProfileEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'personal_account_id', nullable: true, unique: true })
  personalAccountId: string | null;

  @OneToOne(() => AccountEntity, { nullable: true, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'personal_account_id' })
  personalAccount: AccountEntity | null;

  @Column({ name: 'organization_id', nullable: true, unique: true })
  organizationId: string | null;

  @OneToOne(() => OrganizationEntity, { nullable: true, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'organization_id' })
  organization: OrganizationEntity | null;

  @Column({ name: 'current_plan_code', nullable: true })
  currentPlanCode: string | null;

  @ManyToOne(() => PlanEntity, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'current_plan_code', referencedColumnName: 'code' })
  currentPlan: PlanEntity | null;

  @Column({ name: 'stripe_customer_id', nullable: true, unique: true })
  stripeCustomerId: string | null;

  @Column({ name: 'stripe_subscription_id', nullable: true, unique: true })
  stripeSubscriptionId: string | null;

  @Column({
    type: 'enum',
    enum: BILLING_PROFILE_STATUS_ENUM,
    default: BILLING_PROFILE_STATUS_ENUM.INCOMPLETE,
  })
  status: BILLING_PROFILE_STATUS_ENUM;

  @Column({ name: 'current_period_start', type: 'timestamptz', nullable: true })
  currentPeriodStart: Date | null;

  @Column({ name: 'current_period_end', type: 'timestamptz', nullable: true })
  currentPeriodEnd: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
