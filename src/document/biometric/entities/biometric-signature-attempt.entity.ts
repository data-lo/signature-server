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
import { DocumentEntity } from '../../entities/document.entity';
import { CollaboratorEntity } from '../../entities/collaborator.entity';
import type { GeolocationDto } from '../../dto/sign-document.dto';
import { BIOMETRIC_SIGNATURE_PROVIDER_ENUM } from '../enums/biometric-signature-provider.enum';
import { BIOMETRIC_SIGNATURE_ATTEMPT_STATUS_ENUM } from '../enums/biometric-signature-attempt-status.enum';

/**
 * Un intento de autorizar con biometría la firma de UN colaborador sobre UN documento.
 *
 * No es `identity_verifications`, a propósito: aquélla responde "¿esta persona es quien dice ser?"
 * una vez, durante el onboarding; ésta responde "¿esta persona autorizó, en este momento, firmar
 * este PDF?" cada vez que firma. Mezclarlas haría que aprobar una firma pudiera tocar la credencial
 * de onboarding, o que una verificación de identidad pudiera firmar un documento.
 *
 * Es un historial: un colaborador puede acumular intentos rechazados o vencidos antes del que se
 * aprueba. Sólo puede haber UNO abierto a la vez (índice único parcial, ver la migración
 * `CreateBiometricSignatureAttempts`).
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
 * Un solo intento abierto por colaborador: cierra la carrera de dos "Firmar con biometría"
 * simultáneos. La lista de estados es `ACTIVE_BIOMETRIC_SIGNATURE_ATTEMPT_STATUSES`.
 */
@Index(
  'UQ_biometric_signature_attempts_active_collaborator',
  ['collaboratorId'],
  {
    unique: true,
    where: `"status" IN ('PENDING', 'IN_PROGRESS', 'IN_REVIEW')`,
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

  /** Usuario autenticado que inició la sesión. Didit lo devuelve como `vendor_data`. */
  @Column({ name: 'user_id', type: 'uuid' })
  userId: string;

  @ManyToOne(() => UserEntity, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'user_id',
    foreignKeyConstraintName: 'FK_biometric_signature_attempts_user_id',
  })
  user?: UserEntity;

  @Column({ type: 'enum', enum: BIOMETRIC_SIGNATURE_PROVIDER_ENUM })
  provider: BIOMETRIC_SIGNATURE_PROVIDER_ENUM;

  /**
   * `session_id` de Didit: la llave con la que el webhook encuentra el intento. Única por
   * proveedor, para que una sesión nunca pueda aplicarse a dos firmas.
   *
   * Nullable sólo entre crear la fila y recibir la respuesta de Didit; si el alta falla, la fila
   * queda en FAILED sin sesión.
   */
  @Column({ name: 'provider_session_id', type: 'varchar', nullable: true })
  providerSessionId: string | null;

  /** Workflow de Didit con el que se creó la sesión (liveness + face match). */
  @Column({ name: 'provider_workflow_id', type: 'varchar', nullable: true })
  providerWorkflowId: string | null;

  /**
   * `documents.original_hash` en el momento de iniciar la sesión: el PDF exacto que el firmante
   * aceptó firmar. Al aprobarse se compara con el hash vigente, y si el documento cambió entre
   * medias la aprobación no firma nada.
   */
  @Column({ name: 'document_hash', type: 'varchar' })
  documentHash: string;

  @Column({
    type: 'enum',
    enum: BIOMETRIC_SIGNATURE_ATTEMPT_STATUS_ENUM,
    default: BIOMETRIC_SIGNATURE_ATTEMPT_STATUS_ENUM.PENDING,
  })
  status: BIOMETRIC_SIGNATURE_ATTEMPT_STATUS_ENUM;

  /**
   * Ubicación declarada por el dispositivo al iniciar. Toda firma exige geolocalización como
   * evidencia, y cuando la firma se registra —desde el webhook— ya no hay dispositivo al que
   * pedírsela: se toma la que el firmante dio al pulsar "Firmar con biometría".
   */
  @Column({ type: 'jsonb' })
  geolocation: GeolocationDto;

  /**
   * Datos operativos de la sesión (URL hospedada y respuesta cruda del alta). Nunca la API key ni
   * el `session_token`.
   */
  @Column({ name: 'provider_metadata', type: 'jsonb', nullable: true })
  providerMetadata: Record<string, unknown> | null;

  /** Veredicto completo de Didit (liveness y face match), tal como llegó en el webhook. */
  @Column({ type: 'jsonb', nullable: true })
  decision: Record<string, unknown> | null;

  /** Motivo legible del rechazo, del error del proveedor o de por qué no se pudo firmar. */
  @Column({ name: 'failure_reason', type: 'text', nullable: true })
  failureReason: string | null;

  @Column({ name: 'expires_at', type: 'timestamptz', nullable: true })
  expiresAt: Date | null;

  /** Cuándo llegó la aprobación de Didit. Se conserva aunque la firma no se haya podido aplicar. */
  @Column({ name: 'approved_at', type: 'timestamptz', nullable: true })
  approvedAt: Date | null;

  /** Cuándo el intento llegó a un estado terminal. */
  @Column({ name: 'completed_at', type: 'timestamptz', nullable: true })
  completedAt: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
