import { DocumentEntity } from 'src/document/entities/document.entity';
import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  OneToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { CreditLotEntity } from './credit-lot.entity';
import { BILLING_SIGNATURE_TYPE_ENUM } from '../enums/billing-signature-type.enum';

@Entity('document_credit_consumptions')
@Check('CHK_document_credit_consumptions_units', '"units" = 1')
export class DocumentCreditConsumptionEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'document_id', unique: true })
  documentId: string;

  @OneToOne(() => DocumentEntity, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'document_id' })
  document: DocumentEntity;

  @Column({ name: 'credit_lot_id' })
  creditLotId: string;

  @ManyToOne(() => CreditLotEntity, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'credit_lot_id' })
  creditLot: CreditLotEntity;

  @Column({ type: 'integer', default: 1 })
  units: number;

  @Column({
    name: 'signature_type',
    type: 'enum',
    enum: BILLING_SIGNATURE_TYPE_ENUM,
  })
  signatureType: BILLING_SIGNATURE_TYPE_ENUM;

  @CreateDateColumn({ name: 'consumed_at', type: 'timestamptz' })
  consumedAt: Date;

  @Column({ name: 'reversed_at', type: 'timestamptz', nullable: true })
  reversedAt: Date | null;

  @Column({ type: 'text', nullable: true })
  reason: string | null;
}
