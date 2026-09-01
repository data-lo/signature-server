import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { PlanEntity } from './plan.entity';

@Entity('document_pack_offers')
@Check('CHK_document_pack_offers_documents', '"documents_granted" > 0')
@Check('CHK_document_pack_offers_amount', '"amount" >= 0')
export class DocumentPackOfferEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;
  @Column({ name: 'eligible_plan_code', nullable: true, length: 64 })
  eligiblePlanCode: string | null;

  @ManyToOne(() => PlanEntity, (plan) => plan.documentPackOffers, {
    nullable: true,
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'eligible_plan_code', referencedColumnName: 'code' })
  eligiblePlan: PlanEntity | null;

  @Column({ name: 'documents_granted', type: 'integer' })
  documentsGranted: number;

  @Column({ name: 'stripe_price_id', unique: true })
  stripePriceId: string;

  /**
   * `prod_...` de Stripe. Nullable y sin relación con `stripePriceId` de arriba: ese es el
   * PRECIO (obligatorio, es lo que se cobra), este es el PRODUCTO al que pertenece (opcional,
   * lo escribe `CatalogSyncService` al recibir `product.created`/`updated`). Un paquete puede
   * existir localmente, con su precio real ya dado de alta, antes de que su producto de Stripe
   * se sincronice — o si el paquete no se modela como producto propio en Stripe.
   */
  @Column({
    name: 'stripe_product_id',
    type: 'varchar',
    unique: true,
    nullable: true,
  })
  stripeProductId: string | null;

  /**
   * Nombre comercial, tomado del producto de Stripe (`CatalogSyncService`). Nullable porque el
   * paquete puede existir localmente antes de vincularse a un producto — a diferencia de
   * `PlanEntity.name`, aquí no hay ningún otro origen que lo provea antes de esa sincronización.
   */
  @Column({ type: 'varchar', length: 120, nullable: true })
  name: string | null;

  @Column({ type: 'integer' })
  amount: number;

  @Column({ type: 'varchar', length: 3 })
  currency: string;

  @Column({ default: true })
  active: boolean;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
