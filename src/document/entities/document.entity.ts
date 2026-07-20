import { SignatureCoordinates } from 'src/shared/document-signing/interfaces/signature-coordinates.interface';
import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { UserEntity } from 'src/user/entities/user.entity';
import { AccountEntity } from 'src/account/entities/account.entity';
import { OrganizationEntity } from 'src/account/entities/organization.entity';
import { DOCUMENT_STATUS_ENUM } from '../enum/document-status.enum';
import { CollaboratorEntity } from './collaborator.entity';

// document.entity.ts
@Entity('documents')
export class DocumentEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'object_key' })
  objectKey: string;

  @Column({ name: 'file_name' })
  fileName: string;

  @Column({ name: 'file_type' })
  fileType: string;

  @Column({ name: 'total_pages' })
  totalPages: number;

  @Column({ name: 'document_url', nullable: true })
  documentUrl: string;

  @Column({ name: 'ip_address' })
  ipAddress: string;

  @Column({ name: 'original_hash' })
  originalHash: string;

  @Column({ name: 'signed_hash', nullable: true })
  signedHash: string;

  @Column({ name: 'signed_at', nullable: true })
  signedAt: Date;

  @Column({ name: 'cancelled_at', nullable: true })
  cancelledAt: Date;

  @Column({ name: 'rejected_at', nullable: true })
  rejectedAt: Date;

  @Column({ name: 'is_notified', default: false })
  isNotified: boolean;

  @Column({
    name: 'status',
    type: 'enum',
    enum: DOCUMENT_STATUS_ENUM,
    default: DOCUMENT_STATUS_ENUM.CREATED,
  })
  status: DOCUMENT_STATUS_ENUM;

  @Column({ name: 'signature_coordinates', type: 'jsonb', nullable: true })
  signatureCoordinates: SignatureCoordinates;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;

  @Column({ name: 'created_by' })
  createdBy: string;

  @ManyToOne(() => UserEntity, (user) => user.createdDocuments)
  @JoinColumn({ name: 'created_by' })
  requestedBy: UserEntity;

  @Column({ name: 'account_id' })
  accountId: string;

  @ManyToOne(() => AccountEntity)
  @JoinColumn({ name: 'account_id' })
  account: AccountEntity;

  /** Ya es el comportamiento implícito hoy (sign_order siempre se exige en orden) — default true. */
  @Column({ default: true, name: 'is_sequential' })
  isSequential: boolean;

  @Column({ nullable: true, name: 'expiration_date' })
  expirationDate: Date | null;

  /**
   * Clave real de aislamiento multi-tenant para documentos en contexto de organización (ver
   * plan de migración ER-V2, Fase 5, decisión D5). NULL para documentos en contexto personal,
   * donde `accountId` (única por usuario) ya es suficiente. `Account` es una fila por
   * (usuario × contexto) desde la fusión de la Fase 5, así que ya no sirve para agrupar a
   * todos los miembros de una misma organización — `organizationId` sí.
   */
  @Column({ nullable: true, name: 'organization_id' })
  organizationId: string | null;

  @ManyToOne(() => OrganizationEntity, { nullable: true })
  @JoinColumn({ name: 'organization_id' })
  organization: OrganizationEntity | null;

  @Column({ default: 0, name: 'visibility_level' })
  visibilityLevel: number;

  @Column({ name: 'seal_key' })
  sealKey: string;

  @Column({ name: 'total_signers' })
  totalSigners: number;

  @Column({ default: 0, name: 'completed_signers_count' })
  completedSignersCount: number;

  /** No-op hasta el flujo de revisión (ver Fase 6 del plan, rol REVIEWER). */
  @Column({ nullable: true, name: 'reviewed_by' })
  reviewedBy: string | null;

  @Column({ default: false, name: 'requires_verification' })
  requiresVerification: boolean;

  @Column({ default: false, name: 'index_document' })
  indexDocument: boolean;

  @OneToMany(
    () => CollaboratorEntity,
    (collaborator) => collaborator.document,
    {
      cascade: true,
    },
  )
  collaborators: CollaboratorEntity[];
}
