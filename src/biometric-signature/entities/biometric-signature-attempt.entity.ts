import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';
import { UserEntity } from 'src/user/entities/user.entity';
import { DocumentEntity } from 'src/document/entities/document.entity';
import { CollaboratorEntity } from 'src/document/entities/collaborator.entity';
import type { GeolocationDto } from 'src/document/dto/sign-document.dto';
import { IdentityVerificationEntity } from 'src/identity-verification/entities/identity-verification.entity';
import { BIOMETRIC_SIGNATURE_PROVIDER_ENUM } from '../enums/biometric-signature-provider.enum';
import { BIOMETRIC_SIGNATURE_ATTEMPT_STATUS_ENUM } from '../enums/biometric-signature-attempt-status.enum';
import type { BiometricDecisionEvidence } from '../interfaces/biometric-decision-evidence.interface';

/**
 * Un intento de autorizar con biometría la firma de UN colaborador sobre UN documento.
 *
 * Sirve a dos tipos de firmante:
 * - **Con cuenta**: `userId` y `identityVerificationId` apuntan al usuario y a su identidad Didit
 *   aprobada, contra la que se hace el face match (workflow de Biometric Authentication).
 * - **Invitado sin cuenta**: ambos quedan en `null`; la relación es `collaboratorId` +
 *   `emailSnapshot`, y Didit hace KYC completo (identificación + prueba de vida + face match).
 *
 * No es `identity_verifications`: aquélla responde "¿quién es esta persona?" una vez; ésta, "¿esta
 * persona autorizó firmar ESTE PDF, ahora?" cada vez que firma.
 */
@Entity('biometric_signature_attempts')
@Unique('UQ_biometric_signature_attempts_provider_session', [
  'provider',
  'providerSessionId',
])
@Index('IDX_biometric_signature_attempts_collaborator_created', [
  'collaboratorId',
  'createdAt',
])
/**
 * Un solo intento abierto por colaborador y PDF: cierra la carrera de dos "Firmar con biometría"
 * simultáneos. La lista de estados es `ACTIVE_BIOMETRIC_SIGNATURE_ATTEMPT_STATUSES`.
 */
@Index(
  'UQ_biometric_signature_attempts_active',
  ['collaboratorId', 'documentHash'],
  {
    unique: true,
    where: `"status" IN ('PENDING', 'IN_PROGRESS')`,
  },
)
export class BiometricSignatureAttemptEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'document_id', type: 'uuid' })
  documentId: string;

  @ManyToOne(() => DocumentEntity, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'document_id',
    foreignKeyConstraintName: 'FK_biometric_signature_attempts_document_id',
  })
  document?: DocumentEntity;

  @Column({ name: 'collaborator_id', type: 'uuid' })
  collaboratorId: string;

  @ManyToOne(() => CollaboratorEntity, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'collaborator_id',
    foreignKeyConstraintName: 'FK_biometric_signature_attempts_collaborator_id',
  })
  collaborator?: CollaboratorEntity;

  /** Usuario autenticado que inició la sesión; `null` para invitados sin cuenta. */
  @Column({ name: 'user_id', type: 'uuid', nullable: true })
  userId: string | null;

  /**
   * `SET NULL` y no `CASCADE`: borrar al usuario no puede borrar la evidencia de una firma que ya
   * produjo efectos. El intento conserva colaborador, correo y veredicto.
   */
  @ManyToOne(() => UserEntity, { onDelete: 'SET NULL' })
  @JoinColumn({
    name: 'user_id',
    foreignKeyConstraintName: 'FK_biometric_signature_attempts_user_id',
  })
  user?: UserEntity | null;

  /**
   * Correo de la invitación al iniciar el intento. Es evidencia: el correo del colaborador puede
   * cambiar después, y el intento tiene que seguir diciendo a quién se le pidió la firma.
   */
  @Column({ name: 'email_snapshot', type: 'varchar', update: false })
  emailSnapshot: string;

  /** Identidad Didit aprobada usada como referencia del face match; `null` para invitados. */
  @Column({ name: 'identity_verification_id', type: 'uuid', nullable: true })
  identityVerificationId: string | null;

  @ManyToOne(() => IdentityVerificationEntity, { onDelete: 'SET NULL' })
  @JoinColumn({
    name: 'identity_verification_id',
    foreignKeyConstraintName:
      'FK_biometric_signature_attempts_identity_verification_id',
  })
  identityVerification?: IdentityVerificationEntity | null;

  @Column({ type: 'enum', enum: BIOMETRIC_SIGNATURE_PROVIDER_ENUM })
  provider: BIOMETRIC_SIGNATURE_PROVIDER_ENUM;

  /**
   * `session_id` de Didit: la llave con la que el webhook encuentra el intento. Única por
   * proveedor. Nullable sólo entre crear la fila y recibir la respuesta de Didit.
   */
  @Column({ name: 'provider_session_id', type: 'varchar', nullable: true })
  providerSessionId: string | null;

  /** Workflow con el que se abrió la sesión: Biometric Authentication (cuenta) o KYC (invitado). */
  @Column({ name: 'provider_workflow_id', type: 'varchar' })
  providerWorkflowId: string;

  @Column({
    type: 'enum',
    enum: BIOMETRIC_SIGNATURE_ATTEMPT_STATUS_ENUM,
    default: BIOMETRIC_SIGNATURE_ATTEMPT_STATUS_ENUM.PENDING,
  })
  status: BIOMETRIC_SIGNATURE_ATTEMPT_STATUS_ENUM;

  /**
   * `documents.original_hash` al iniciar: el PDF exacto que el firmante aceptó firmar. Inmutable
   * (`update: false`); si el hash vigente deja de coincidir, la aprobación no firma nada.
   */
  @Column({ name: 'document_hash', type: 'varchar', update: false })
  documentHash: string;

  /**
   * Ubicación declarada por el dispositivo al iniciar. La firma se registra desde el webhook,
   * cuando ya no hay navegador al que pedírsela.
   */
  @Column({ type: 'jsonb' })
  geolocation: GeolocationDto;

  /** IP desde la que se inició el intento; pasa al colaborador como evidencia de la firma. */
  @Column({ name: 'ip_address', type: 'varchar', nullable: true })
  ipAddress: string | null;

  /** Cuándo aceptó el firmante el tratamiento de sus datos biométricos para esta firma. */
  @Column({ name: 'consented_at', type: 'timestamptz' })
  consentedAt: Date;

  /**
   * Datos operativos de la sesión (URL hospedada y respuesta del alta, sin `session_token`). La
   * URL no se registra en logs.
   */
  @Column({ name: 'provider_metadata', type: 'jsonb', nullable: true })
  providerMetadata: Record<string, unknown> | null;

  /**
   * Veredicto MÍNIMO de Didit (ver `toBiometricDecisionEvidence`): estado, puntaje y método de
   * cada prueba. Nunca URLs de imágenes ni datos de la identificación. Aun así es dato biométrico
   * derivado: no se expone al frontend ni se registra en logs.
   */
  @Column({ type: 'jsonb', nullable: true })
  decision: BiometricDecisionEvidence | null;

  /** Motivo legible del rechazo, del error del proveedor o de por qué no se pudo firmar. */
  @Column({ name: 'failure_reason', type: 'text', nullable: true })
  failureReason: string | null;

  /** Cuándo quedó abierta la sesión en Didit. */
  @Column({ name: 'started_at', type: 'timestamptz', nullable: true })
  startedAt: Date | null;

  @Column({ name: 'expires_at', type: 'timestamptz', nullable: true })
  expiresAt: Date | null;

  /** Cuándo llegó a un estado terminal. */
  @Column({ name: 'completed_at', type: 'timestamptz', nullable: true })
  completedAt: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
