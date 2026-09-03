import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
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
  @Column({ name: 'eligible_plan_type', nullable: true, length: 64 })
  eligiblePlanType: string | null;

  @ManyToOne(() => PlanEntity, (plan) => plan.documentPackOffers, {
    nullable: true,
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'eligible_plan_type', referencedColumnName: 'planType' })
  eligiblePlan: PlanEntity | null;

  @Column({ name: 'documents_granted', type: 'integer' })
  documentsGranted: number;

  @Column({ name: 'stripe_price_id', unique: true })
  stripePriceId: string;

  /**
   * `prod_...` de Stripe: el PRODUCTO al que pertenece la oferta, no el precio. Es nullable y sin
   * relación con `stripePriceId` —que sí es obligatorio, porque es lo que se cobra— porque un
   * paquete puede existir localmente antes de que su producto se sincronice, o no modelarse como
   * producto propio en Stripe.
   *
   * **No es único**, a diferencia de `stripePriceId`: cada combinación de plan elegible y tamaño es
   * una fila con su propio `price_...` bajo el mismo `prod_...`. Lo que identifica a la oferta es el
   * precio.
   */
  @Column({
    name: 'stripe_product_id',
    type: 'varchar',
    nullable: true,
  })
  @Index('IDX_document_pack_offers_stripe_product_id')
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
