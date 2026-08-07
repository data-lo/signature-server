import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { AccountEntity } from 'src/account/entities/account.entity';
import { DocumentEntity } from './document.entity';
import { SimpleSignatureEntity } from 'src/signature/entities/simple-signature.entity';
import { FielSignatureEntity } from 'src/signature/entities/fiel-signature.entity';
import { COLABORATOR_TYPE_ENUM } from '../enum/colaborator-type.enum';
import { SIGNEE_STATUS_ENUM } from '../enum/signee-status.enum';
import { REMINDER_PERIODICITY_ENUM } from '../enum/reminder-periodicity.enum';
import { SIGNATURE_TYPE_ENUM } from '../enum/signature-type.enum';
import type { SignatureResult } from 'src/efirma/interfaces/signature-result.interface';

/**
 * Reemplaza a DocumentParticipantEntity (ver plan de migración ER-V2, Fase 3). Generaliza
 * "participante" a "colaborador": agrega el rol REVIEWER, permite invitar solo por email
 * (accountId nullable) sin que exista una cuenta de plataforma todavía, y suma comments/geoLoc/
 * cancellationReason/reminderPeriodicity/signatureType que no existían antes.
 *
 * `accountId` reemplazó a `userId` (ver diagrama ER-V2 más reciente / migración
 * `RenameCollaboratorUserIdToAccountId`): apunta a la cuenta PERSONAL del colaborador, no
 * directamente a `UserEntity`, consistente con el resto del modelo multi-tenant.
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

  /**
   * NULL cuando el colaborador fue invitado solo por email (sin cuenta de plataforma todavía).
   * Ancla a la cuenta PERSONAL del usuario (no a una membresía de organización específica, ver
   * `AccountMemberService.findPersonalAccountId`) — evita la ambigüedad de "cuál cuenta" cuando
   * una persona pertenece a varias organizaciones, y sigue resolviendo 1:1 a `AccountEntity.user`
   * para todo lo que dependía de la identidad real de la persona (firma/INE, nombre, email).
   */
  @Column({ name: 'account_id', nullable: true })
  accountId: string | null;

  @ManyToOne(() => AccountEntity, { nullable: true })
  @JoinColumn({ name: 'account_id' })
  account: AccountEntity | null;

  /** Poblado cuando accountId es null — invitación por email sin cuenta. */
  @Column({ nullable: true })
  email: string | null;

  /**
   * Nombre/apellido capturados al invitar (ver historia "Frontend: Carga de Documentos y
   * Configuración de Firmantes") — NULL para colaboradores creados antes de esa historia o por
   * flujos que no los piden. `collaboratorDisplayName()` en document.service.ts los usa como
   * fallback antes de caer al email crudo.
   */
  @Column({ name: 'first_name', nullable: true })
  firstName: string | null;

  @Column({ name: 'last_name', nullable: true })
  lastName: string | null;

  /** Solo para colaboradores VIEWER, o SIGNER con signatureType ADVANCED (ver historia de frontend). */
  @Column({ nullable: true })
  rfc: string | null;

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

  /** Modelo de datos histórico (ver Fase 8 del plan) — la validación/firma FIEL real se resuelve
   * en el momento de firmar vía `EfirmaService` (ver `advancedSignature`), no a través de esta FK. */
  @Column({ name: 'fiel_signature_id', nullable: true })
  fielSignatureId: string | null;

  /**
   * Copia inmutable de la imagen de firma tomada en el momento en que este colaborador firmó
   * (ver migración `AddSignatureSnapshotToCollaborators`). `finalizeSignedDocument` usa esto en
   * vez de volver a resolver `user.signatureId` en vivo — si el usuario desactiva o reemplaza
   * su firma después de firmar este documento, el PDF final no debe verse afectado. NULL hasta
   * que el colaborador firma. Solo aplica a `signatureType === SIMPLE`.
   */
  @Column({ name: 'signature_snapshot_object_key', nullable: true })
  signatureSnapshotObjectKey: string | null;

  /**
   * Resultado NO sensible de `EfirmaService.firmar` (hash del documento, firma en base64,
   * algoritmo, fecha, y datos públicos del certificado) tomado en el momento real de la firma —
   * nunca contiene la llave privada ni la contraseña, esas nunca se persisten. Solo aplica a
   * `signatureType === FIEL` (ver historia "Integrar carga y validación de e.firma en el flujo
   * de firma avanzada"). NULL hasta que el colaborador firma o si firmó con firma simple.
   */
  @Column({ name: 'advanced_signature', type: 'jsonb', nullable: true })
  advancedSignature: SignatureResult | null;

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
