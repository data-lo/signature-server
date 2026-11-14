import {
  Check,
  Column,
  Entity,
  JoinColumn,
  OneToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { CatalogItemEntity } from './catalog-item.entity';
import { CREDIT_TYPE_ENUM } from '../enums/credit-type.enum';

/**
 * Datos propios de un ítem que acredita créditos; el dinero vive en catalog_prices.
 *
 * `documentsGranted` es cuántos créditos concede una unidad, y `creditType` de qué tipo son: un
 * paquete biométrico acredita créditos `BIOMETRIC_SIGNATURE` con la misma compra suelta que uno de
 * documentos.
 */
@Entity('document_credit_packs')
@Check('CHK_document_credit_packs_documents', '"documents_granted" > 0')
export class DocumentCreditPackEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'catalog_item_id', unique: true })
  catalogItemId: string;

  @OneToOne(() => CatalogItemEntity, (item) => item.documentCreditPack, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'catalog_item_id' })
  catalogItem: CatalogItemEntity;

  @Column({ name: 'documents_granted', type: 'integer' })
  documentsGranted: number;

  @Column({
    name: 'credit_type',
    type: 'enum',
    enum: CREDIT_TYPE_ENUM,
    enumName: 'credit_type_enum',
    default: CREDIT_TYPE_ENUM.DOCUMENT_SIGNATURE,
  })
  creditType: CREDIT_TYPE_ENUM;
}
