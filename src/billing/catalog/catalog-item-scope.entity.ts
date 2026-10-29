import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { CATALOG_SCOPE_SUBJECT_TYPE_ENUM } from '../enums/catalog-scope-subject-type.enum';
import { CatalogItemEntity } from './catalog-item.entity';

/**
 * Una fila hace el ítem visible para un dueño concreto. Un ítem sin scopes se considera global.
 * No hay FK polimórfica a account/organization por diseño; subjectType define la tabla dueña.
 */
@Entity('catalog_item_scopes')
@Index(
  'UQ_catalog_item_scopes_subject',
  ['catalogItemId', 'subjectType', 'subjectId'],
  {
    unique: true,
  },
)
export class CatalogItemScopeEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'catalog_item_id' })
  catalogItemId: string;

  @ManyToOne(() => CatalogItemEntity, (item) => item.scopes, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'catalog_item_id' })
  catalogItem: CatalogItemEntity;

  @Column({
    name: 'subject_type',
    type: 'enum',
    enum: CATALOG_SCOPE_SUBJECT_TYPE_ENUM,
  })
  subjectType: CATALOG_SCOPE_SUBJECT_TYPE_ENUM;

  @Column({ name: 'subject_id' })
  subjectId: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
