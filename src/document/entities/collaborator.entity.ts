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
import { SimpleSignatureEntity } from './simple-signature.entity';
import { FielSignatureEntity } from './fiel-signature.entity';
import { COLABORATOR_TYPE_ENUM } from '../enum/colaborator-type.enum';
import { SIGNEE_STATUS_ENUM } from '../enum/signee-status.enum';
import { REMINDER_PERIODICITY_ENUM } from '../enum/reminder-periodicity.enum';
import { SIGNATURE_TYPE_ENUM } from '../enum/signature-type.enum';

/**
 * Reemplaza a DocumentParticipantEntity (ver plan de migración ER-V2, Fase 3). Generaliza
 * "participante" a "colaborador": agrega el rol REVIEWER, permite invitar solo por email
 * (userId nullable) sin que exista una cuenta de plataforma todavía, y suma comments/geoLoc/
 * cancellationReason/reminderPeriodicity/signatureType que no existían antes.
 */
@Entity('collaborators')
export class CollaboratorEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'document_id' })
  documentId: string;

  @ManyToOne(() => DocumentEntity, (document) => document.collaborators, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'document_id' })
  document: DocumentEntity;

  /** NULL cuando el colaborador fue invitado solo por email (sin cuenta de plataforma todavía). */
  @Column({ name: 'user_id', nullable: true })
  userId: string | null;

  @ManyToOne(() => UserEntity, { nullable: true })
  @JoinColumn({ name: 'user_id' })
  user: UserEntity | null;

  /** Poblado cuando userId es null — invitación por email sin cuenta. */
  @Column({ nullable: true })
  email: string | null;

  @Column({ name: 'signing_order', nullable: true })
  signingOrder: number | null;

  @Column({ name: 'signed_at', nullable: true })
  signedAt: Date | null;

  @Column({
    type: 'enum',
    enum: SIGNEE_STATUS_ENUM,
    default: SIGNEE_STATUS_ENUM.PENDING,
  })
  status: SIGNEE_STATUS_ENUM;

  @Column({ type: 'text', nullable: true })
  comments: string | null;

  @Column({ name: 'ip_address' })
  ipAddress: string;

  @Column({ name: 'geo_loc', type: 'jsonb', nullable: true })
  geoLoc: Record<string, unknown> | null;

  @Column({ name: 'visibility_level', nullable: true })
  visibilityLevel: number | null;

  /** Mapea desde el antiguo rejectionReason — aproximación (ver migración de la Fase 3: "rechazo" y "cancelación" no son lo mismo conceptualmente). */
  @Column({ name: 'cancellation_reason', type: 'text', nullable: true })
  cancellationReason: string | null;

  @Column({
    name: 'reminder_periodicity',
    type: 'enum',
    enum: REMINDER_PERIODICITY_ENUM,
    nullable: true,
  })
  reminderPeriodicity: REMINDER_PERIODICITY_ENUM | null;

  /** Coordenadas de firma explícitas de este colaborador (ver Fase 4 del plan). NULL = usa el apilado automático. */
  @Column({ name: 'simple_signature_id', nullable: true })
  simpleSignatureId: string | null;

  @ManyToOne(() => SimpleSignatureEntity, { nullable: true })
  @JoinColumn({ name: 'simple_signature_id' })
  simpleSignature: SimpleSignatureEntity | null;

  /** Modelo de datos únicamente (ver Fase 8 del plan) — sin lógica de firma FIEL conectada todavía. */
  @Column({ name: 'fiel_signature_id', nullable: true })
  fielSignatureId: string | null;

  @ManyToOne(() => FielSignatureEntity, { nullable: true })
  @JoinColumn({ name: 'fiel_signature_id' })
  fielSignature: FielSignatureEntity | null;

  @Column({
    name: 'signature_type',
    type: 'enum',
    enum: SIGNATURE_TYPE_ENUM,
    nullable: true,
  })
  signatureType: SIGNATURE_TYPE_ENUM | null;

  @Column({
    name: 'colaborator_type',
    type: 'enum',
    enum: COLABORATOR_TYPE_ENUM,
  })
  colaboratorType: COLABORATOR_TYPE_ENUM;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
