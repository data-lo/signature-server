import { AccountEntity } from 'src/account/entities/account.entity';
import { OrganizationEntity } from 'src/account/entities/organization.entity';
import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  OneToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { BILLING_PROFILE_STATUS_ENUM } from '../enums/billing-profile-status.enum';
import { BILLING_SOURCE_ENUM } from '../enums/billing-source.enum';
import { PlanEntity } from '../catalog/plan.entity';

@Entity('billing_profiles')
/**
 * El índice exacto de la consulta de `ExpireManualSubscriptionsJob`, y parcial por lo mismo que
 * ella: sólo mira perfiles manuales activos. Se declara acá —y no sólo en la migración— para que
 * un `migration:generate` posterior no lo proponga como sobrante y lo borre.
 */
@Index('IDX_billing_profiles_manual_expiry', ['currentPeriodEnd'], {
  where: `"billing_source" = 'MANUAL' AND "status" = 'ACTIVE'`,
})
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
   * Quién gobierna el ciclo de vida de este perfil. Ver `BILLING_SOURCE_ENUM`: NO sustituye a
   * `current_plan_type` ni se deduce de él —aquél dice qué beneficios hay, éste quién los
   * administra— y es lo único que decide si `ExpireManualSubscriptionsJob` puede tocar la fila.
   *
   * Por defecto `FREE` porque es el estado con el que nace toda cuenta y porque es el valor
   * INOFENSIVO: un perfil mal etiquetado como `FREE` o `STRIPE` queda fuera del alcance del
   * cron, mientras que uno mal etiquetado como `MANUAL` acabaría degradado a Free sin que nadie
   * lo pidiera. Ante la duda, el que no quita servicio.
   */
  @Column({
    name: 'billing_source',
    type: 'enum',
    enum: BILLING_SOURCE_ENUM,
    enumName: 'billing_source_enum',
    default: BILLING_SOURCE_ENUM.FREE,
  })
  billingSource: BILLING_SOURCE_ENUM;

  /**
   * El cliente pidió la baja pero conserva el servicio hasta que acabe lo pagado.
   *
   * Lo mantiene cada origen a su manera —Stripe lo trae en la suscripción, la facturación manual
   * lo escribiría al registrar la baja— y el cron lo devuelve a `false` al expirar un periodo
   * manual: una vez consumido, la intención de cancelar ya se cumplió y dejarla puesta haría que
   * la próxima alta naciera marcada para cancelarse.
   */
  @Column({ name: 'cancel_at_period_end', type: 'boolean', default: false })
  cancelAtPeriodEnd: boolean;

  @Column({ name: 'current_period_start', type: 'timestamptz', nullable: true })
  currentPeriodStart: Date | null;

  /**
   * Fin del periodo vigente. **Sobrevive a la expiración**: cuando el cron devuelve el perfil a
   * Free deja este valor donde está en vez de anularlo, porque es la respuesta a "¿hasta cuándo
   * tuvo plan este cliente?" y es lo que permite ofrecerle una renovación. `current_period_start`
   * sí se anula: un periodo terminado no tiene inicio vigente que declarar.
   */
  @Column({ name: 'current_period_end', type: 'timestamptz', nullable: true })
  currentPeriodEnd: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
