import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { DocumentEntity } from './document.entity';
import { CollaboratorEntity } from './collaborator.entity';
import { VERIFICATION_EVENT_ENUM } from '../enum/verification-event.enum';

/**
 * Respalda con persistencia real al OTPService ya existente (ver plan de migración ER-V2,
 * Fase 7) — src/shared/otp/otp.service.ts generaba códigos desde su creación pero no tenía
 * ningún caller: `generate()` crea un secreto efímero y descarta el resultado sin guardarlo,
 * y `verify()` es una comparación de strings directa (no valida TOTP real contra un secreto
 * persistido). La expiración real (`expiredAt`) y el estado de uso (`isUsed`) los gobierna
 * esta entidad/VerificationCodeService, no OTPService.
 */
@Entity('verification_codes')
export class VerificationCodeEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  code: string;

  @Column({ type: 'enum', enum: VERIFICATION_EVENT_ENUM })
  event: VERIFICATION_EVENT_ENUM;

  @Column({ name: 'is_used', default: false })
  isUsed: boolean;

  @Column({ name: 'used_at', nullable: true })
  usedAt: Date | null;

  @Column({ name: 'ip_address' })
  ipAddress: string;

  @Column({ name: 'expired_at' })
  expiredAt: Date;

  /** Nullable: un código puede emitirse a nivel documento o atado a un firmante específico. */
  @Column({ name: 'signer_id', nullable: true })
  signerId: string | null;

  @ManyToOne(() => CollaboratorEntity, { nullable: true, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'signer_id' })
  signer: CollaboratorEntity | null;

  @Column({ name: 'document_id' })
  documentId: string;

  @ManyToOne(() => DocumentEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'document_id' })
  document: DocumentEntity;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
