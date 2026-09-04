import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  OneToOne,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';
import { PLAN_CREATION_SOURCE_ENUM } from '../enums/plan-creation-source.enum';
import { CatalogItemEntity } from './catalog-item.entity';

@Entity('plans')
@Check('CHK_plans_documents_included', '"documents_included" > 0')
export class PlanEntity {
  @PrimaryColumn({ name: 'plan_type', type: 'varchar', length: 64 })
  planType: string;

  /** La identidad comercial común; planType sigue siendo la llave de beneficios vigente. */
  @Column({ name: 'catalog_item_id', nullable: true, unique: true })
  catalogItemId: string | null;

  @OneToOne(() => CatalogItemEntity, (item) => item.plan, {
    nullable: true,
    onDelete: 'SET NULL',
  })
  @JoinColumn({ name: 'catalog_item_id' })
  catalogItem: CatalogItemEntity | null;

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
}
