import {
  Check,
  Column,
  Entity,
  JoinColumn,
  OneToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { CatalogItemEntity } from './catalog-item.entity';

/** Datos propios de un ítem que acredita documentos; el dinero vive en catalog_prices. */
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
}
