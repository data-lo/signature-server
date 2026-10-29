import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  OneToMany,
  OneToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { CATALOG_ITEM_TYPE_ENUM } from '../enums/catalog-item-type.enum';
import { CATALOG_SOURCE_ENUM } from '../enums/catalog-source.enum';
import { CatalogPriceEntity } from './catalog-price.entity';
import { CatalogItemScopeEntity } from './catalog-item-scope.entity';
import { PlanEntity } from './plan.entity';
import { DocumentCreditPackEntity } from './document-credit-pack.entity';

/**
 * Unidad comercial independiente del proveedor de pago. Puede ser un plan o créditos de
 * documentos, creado manualmente o sincronizado desde Stripe.
 */
@Entity('catalog_items')
@Index('IDX_catalog_items_stripe_product', ['stripeProductId'])
@Index(
  'UQ_catalog_items_stripe_product_type',
  ['stripeProductId', 'itemType'],
  {
    unique: true,
  },
)
export class CatalogItemEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'item_type', type: 'enum', enum: CATALOG_ITEM_TYPE_ENUM })
  itemType: CATALOG_ITEM_TYPE_ENUM;

  @Column({ type: 'enum', enum: CATALOG_SOURCE_ENUM })
  source: CATALOG_SOURCE_ENUM;

  @Column({ length: 120 })
  name: string;

  @Column({ name: 'is_active', default: true })
  isActive: boolean;

  /** Nullable para ítems manuales; no es unique porque Stripe puede publicar variantes locales. */
  @Column({ name: 'stripe_product_id', nullable: true })
  stripeProductId: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;

  @OneToOne(() => PlanEntity, (plan) => plan.catalogItem)
  plan: PlanEntity | null;

  @OneToOne(() => DocumentCreditPackEntity, (pack) => pack.catalogItem)
  documentCreditPack: DocumentCreditPackEntity | null;

  @OneToMany(() => CatalogPriceEntity, (price) => price.catalogItem)
  prices: CatalogPriceEntity[];

  @OneToMany(() => CatalogItemScopeEntity, (scope) => scope.catalogItem)
  scopes: CatalogItemScopeEntity[];
}
