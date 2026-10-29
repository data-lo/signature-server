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
import { IDENTITY_VERIFICATION_PROVIDER_ENUM } from '../enums/identity-verification-provider.enum';
import { IDENTITY_VERIFICATION_STATUS_ENUM } from '../enums/identity-verification-status.enum';

/**
 * Un intento de verificación de identidad contra un proveedor externo.
 *
 * Es un historial, no un estado único por usuario: un usuario puede tener varios intentos
 * (uno abandonado, uno rechazado, uno aprobado) y la fila más reciente es la que gobierna lo
 * que ve en pantalla. Conservar los intentos fallidos importa — es la evidencia de que la
 * identidad detrás de una firma se validó, y cuántas veces se intentó antes.
 */
@Entity('identity_verifications')
@Unique('UQ_identity_verifications_provider_session', [
  'provider',
  'providerSessionId',
])
@Index('IDX_identity_verifications_user_created', ['userId', 'createdAt'])
@Index('IDX_identity_verifications_user_status', ['userId', 'status'])
export class IdentityVerificationEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId: string;

  @ManyToOne(() => UserEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: UserEntity;

  @Column({ type: 'enum', enum: IDENTITY_VERIFICATION_PROVIDER_ENUM })
  provider: IDENTITY_VERIFICATION_PROVIDER_ENUM;

  @Column({
    type: 'enum',
    enum: IDENTITY_VERIFICATION_STATUS_ENUM,
    default: IDENTITY_VERIFICATION_STATUS_ENUM.PENDING,
  })
  status: IDENTITY_VERIFICATION_STATUS_ENUM;

  /**
   * `session_id` de Didit. Es la llave con la que el webhook encuentra este intento, y por eso
   * es única por proveedor: dos filas con la misma sesión harían ambiguo a quién aplicarle el
   * resultado.
   *
   * Nullable sólo durante el instante entre crear la fila en PENDING y recibir la respuesta de
   * Didit. Si la llamada al proveedor falla, la fila queda en FAILED sin sesión.
   */
  @Column({ name: 'provider_session_id', type: 'varchar', nullable: true })
  providerSessionId: string | null;

  /** Workflow de Didit con el que se creó la sesión: qué documentos y checks se pidieron. */
  @Column({ name: 'provider_workflow_id', type: 'varchar', nullable: true })
  providerWorkflowId: string | null;

  /**
   * Datos operativos de la sesión (URL hospedada, `vendor_data`, respuesta cruda del alta).
   * Nunca guarda la API key ni el `session_token`: son secretos del servidor.
   */
  @Column({ name: 'provider_metadata', type: 'jsonb', nullable: true })
  providerMetadata: Record<string, unknown> | null;

  /**
   * Veredicto completo de Didit (`decision`): resultado del face match, del liveness y de la
   * lectura de la INE. Se guarda tal cual llega para poder auditar por qué se aprobó o rechazó
   * una identidad sin depender de que el proveedor conserve el historial.
   */
  @Column({ type: 'jsonb', nullable: true })
  decision: Record<string, unknown> | null;

  /** Motivo legible del rechazo o del error, para mostrar u operar. */
  @Column({ name: 'failure_reason', type: 'text', nullable: true })
  failureReason: string | null;

  /** Cuándo se abrió la sesión hospedada de Didit. */
  @Column({ name: 'started_at', type: 'timestamptz', nullable: true })
  startedAt: Date | null;

  /** Cuándo llegó un estado terminal (aprobado, rechazado, abandonado, expirado). */
  @Column({ name: 'completed_at', type: 'timestamptz', nullable: true })
  completedAt: Date | null;

  @Column({ name: 'expires_at', type: 'timestamptz', nullable: true })
  expiresAt: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
