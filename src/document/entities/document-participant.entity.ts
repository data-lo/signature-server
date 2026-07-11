import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { UserEntity } from 'src/user/entities/user.entity';
import { DocumentEntity } from './document.entity';
import { DOCUMENT_PARTICIPANT_ROLE_ENUM } from '../enum/document-participant-role.enum';
import { DOCUMENT_PARTICIPANT_STATUS_ENUM } from '../enum/document-participant-status.enum';

@Entity('document_participants')
export class DocumentParticipantEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'document_id' })
  documentId: string;

  @ManyToOne(() => DocumentEntity, (document) => document.participants, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'document_id' })
  document: DocumentEntity;

  @Column({ name: 'user_id' })
  userId: string;

  @ManyToOne(() => UserEntity)
  @JoinColumn({ name: 'user_id' })
  user: UserEntity;

  @Column({
    name: 'role',
    type: 'enum',
    enum: DOCUMENT_PARTICIPANT_ROLE_ENUM,
  })
  role: DOCUMENT_PARTICIPANT_ROLE_ENUM;

  @Column({
    name: 'status',
    type: 'enum',
    enum: DOCUMENT_PARTICIPANT_STATUS_ENUM,
    default: DOCUMENT_PARTICIPANT_STATUS_ENUM.PENDING,
  })
  status: DOCUMENT_PARTICIPANT_STATUS_ENUM;

  @Column({ name: 'sign_order', default: 0 })
  signOrder: number;

  @Column({ name: 'signed_at', nullable: true })
  signedAt: Date | null;

  @Column({ name: 'rejected_at', nullable: true })
  rejectedAt: Date | null;

  @Column({ name: 'rejection_reason', type: 'text', nullable: true })
  rejectionReason: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
