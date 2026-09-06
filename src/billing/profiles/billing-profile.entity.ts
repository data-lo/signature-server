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

  @Column({ name: 'current_plan_type', nullable: true })
  currentPlanType: string | null;

  @ManyToOne(() => PlanEntity, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'current_plan_type', referencedColumnName: 'planType' })
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

  /**
   * El cliente pidió la baja y conserva el servicio hasta que acabe lo que ya pagó.
   *
   * **No es un estado**, y por eso convive con `status = ACTIVE`: durante el resto del periodo la
   * suscripción habilita exactamente lo mismo que antes y lo único que cambia es que no se va a
   * renovar. El término de verdad no lo decide esta bandera sino
   * `customer.subscription.deleted`, que es cuando Stripe confirma que la suscripción acabó.
   *
   * Se limpia al finalizar: una vez consumida, dejarla puesta haría que el perfil siguiera
   * anunciando un término que ya ocurrió.
   */
  @Column({ name: 'cancel_at_period_end', type: 'boolean', default: false })
  cancelAtPeriodEnd: boolean;

  /**
   * Inicio del periodo VIGENTE, y por eso se anula al terminar la suscripción: un plan que ya
   * acabó no tiene periodo en curso que declarar. Su pareja `current_period_end` sí sobrevive,
   * como fecha histórica de hasta cuándo tuvo servicio.
   */
  @Column({ name: 'current_period_start', type: 'timestamptz', nullable: true })
  currentPeriodStart: Date | null;

  @Column({ name: 'current_period_end', type: 'timestamptz', nullable: true })
  currentPeriodEnd: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
