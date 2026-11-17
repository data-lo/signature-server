import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';

import { OrganizationEntity } from 'src/account/entities/organization.entity';
import { CreditLotEntity } from 'src/billing/credits/credit-lot.entity';
import { BillingProfileEntity } from 'src/billing/profiles/billing-profile.entity';

/**
 * Constancia de una recarga interna de créditos Enterprise (migración `1784300000092`).
 *
 * Se escribe en la MISMA transacción que su `credit_lot`, así que existe si y sólo si la recarga se
 * confirmó: no hay estado "en curso". Dos peticiones simultáneas con la misma clave se serializan
 * con un bloqueo asesor (`GrantOrganizationCreditsUseCase`), y la segunda encuentra esta fila.
 *
 * Las referencias son `RESTRICT`: a diferencia de una clave de aprovisionamiento, esta fila es la
 * explicación de un saldo y no se libera borrando lo que acreditó.
 */
@Entity('platform_credit_grants')
@Index('UQ_platform_credit_grants_idempotency_key', ['idempotencyKey'], {
  unique: true,
})
@Index('UQ_platform_credit_grants_external_reference', ['externalReference'], {
  unique: true,
})
@Index('UQ_platform_credit_grants_credit_lot_id', ['creditLotId'], {
  unique: true,
})
@Index('IDX_platform_credit_grants_organization_id', ['organizationId'])
@Check(
  'CHK_platform_credit_grants_documents_granted',
  '"documents_granted" > 0',
)
export class PlatformCreditGrantEntity {
  @PrimaryGeneratedColumn('uuid', {
    primaryKeyConstraintName: 'PK_platform_credit_grants',
  })
  id: string;

  @Column({ name: 'organization_id', type: 'uuid' })
  organizationId: string;

  @ManyToOne(() => OrganizationEntity, { onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'organization_id',
    foreignKeyConstraintName: 'FK_platform_credit_grants_organization_id',
  })
  organization: OrganizationEntity;

  @Column({ name: 'billing_profile_id', type: 'uuid' })
  billingProfileId: string;

  @ManyToOne(() => BillingProfileEntity, { onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'billing_profile_id',
    foreignKeyConstraintName: 'FK_platform_credit_grants_billing_profile_id',
  })
  billingProfile: BillingProfileEntity;

  /** El lote `ADD_ON` que creó esta recarga. */
  @Column({ name: 'credit_lot_id', type: 'uuid' })
  creditLotId: string;

  @ManyToOne(() => CreditLotEntity, { onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'credit_lot_id',
    foreignKeyConstraintName: 'FK_platform_credit_grants_credit_lot_id',
  })
  creditLot: CreditLotEntity;

  @Column({ name: 'documents_granted', type: 'integer' })
  documentsGranted: number;

  /** Folio de la recarga en el sistema que la autorizó; único en toda la plataforma. */
  @Column({ name: 'external_reference', type: 'varchar', length: 255 })
  externalReference: string;

  /** Valor del header `Idempotency-Key`, tal como lo mandó el operador. */
  @Column({ name: 'idempotency_key', type: 'varchar', length: 255 })
  idempotencyKey: string;

  /** SHA-256 hexadecimal de la petición; detecta la misma clave reutilizada con otros datos. */
  @Column({ name: 'request_hash', type: 'varchar', length: 64 })
  requestHash: string;

  @Column({ type: 'text', nullable: true })
  notes: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
