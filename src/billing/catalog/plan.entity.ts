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

@Entity('plans')
@Check('CHK_plans_monthly_document_limit', '"monthly_document_limit" > 0')
export class PlanEntity {
  @PrimaryColumn({ type: 'varchar', length: 64 })
  code: string;

  @Column({ length: 120 })
  name: string;

  @Column({ default: true })
  active: boolean;

  /**
   * `prod_...` de Stripe. Nullable: un plan puede existir localmente (con sus límites
   * comerciales ya definidos) antes de vincularse a un producto de Stripe — ver
   * `CatalogSyncService`, que lo escribe la primera vez que llega un `product.created` o
   * `product.updated` con `metadata.planCode` igual a este `code`.
   */
  @Column({
    name: 'stripe_product_id',
    type: 'varchar',
    unique: true,
    nullable: true,
  })
  stripeProductId: string | null;

  @Column({ name: 'monthly_document_limit', type: 'integer' })
  monthlyDocumentLimit: number;

  @Column({ name: 'allow_simple_signature', default: true })
  allowSimpleSignature: boolean;

  @Column({ name: 'allow_advanced_signature', default: true })
  allowAdvancedSignature: boolean;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;

  @OneToMany(() => PlanPriceEntity, (price) => price.plan)
  prices: PlanPriceEntity[];

  @OneToMany(() => DocumentPackOfferEntity, (offer) => offer.eligiblePlan)
  documentPackOffers: DocumentPackOfferEntity[];
}
