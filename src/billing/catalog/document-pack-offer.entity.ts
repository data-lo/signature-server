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
