import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  OneToMany,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';
import { PlanPriceEntity } from './plan-price.entity';
import { DocumentPackOfferEntity } from './document-pack-offer.entity';
import { PLAN_CREATION_SOURCE_ENUM } from '../enums/plan-creation-source.enum';

@Entity('plans')
@Check('CHK_plans_documents_included', '"documents_included" > 0')
export class PlanEntity {
  @PrimaryColumn({ name: 'plan_type', type: 'varchar', length: 64 })
  planType: string;

  @Column({ length: 120 })
  name: string;

  @Column({ name: 'is_active', default: true })
  isActive: boolean;

  /** Se fija en la primera alta y no cambia al sincronizar actualizaciones posteriores. */
  @Column({
    name: 'creation_source',
    type: 'enum',
    enum: PLAN_CREATION_SOURCE_ENUM,
    default: PLAN_CREATION_SOURCE_ENUM.MANUAL,
  })
  creationSource: PLAN_CREATION_SOURCE_ENUM;

  /**
   * `prod_...` de Stripe. Nullable: un plan puede existir localmente (con sus límites
   * comerciales ya definidos) antes de vincularse a un producto de Stripe — ver
   * `CatalogSyncService`, que lo escribe la primera vez que llega un `product.created` o
   * `product.updated` con `metadata.planType` igual a este `planType`.
   */
  @Column({
    name: 'stripe_product_id',
    type: 'varchar',
    unique: true,
    nullable: true,
  })
  stripeProductId: string | null;

  @Column({ name: 'documents_included', type: 'integer' })
  documentsIncluded: number;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;

  @OneToMany(() => PlanPriceEntity, (price) => price.plan)
  prices: PlanPriceEntity[];

  @OneToMany(() => DocumentPackOfferEntity, (offer) => offer.eligiblePlan)
  documentPackOffers: DocumentPackOfferEntity[];
}
