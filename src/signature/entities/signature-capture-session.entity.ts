import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { UserEntity } from 'src/user/entities/user.entity';
import { SignatureEntity } from './signature.entity';
import { SIGNATURE_CAPTURE_CHANNEL_ENUM } from '../enums/signature-capture-channel.enum';
import { SIGNATURE_CAPTURE_SESSION_STATUS_ENUM } from '../enums/signature-capture-session-status.enum';

/**
 * Un intento temporal de captura de la firma manuscrita.
 *
 * Esta tabla **no guarda la imagen ni define el estado definitivo del usuario**. Su propósito es
 * controlar, auditar y proteger cada intento —sobre todo la comunicación PC ↔ teléfono—: quién
 * lo abrió, por qué canal, si el teléfono llegó a reclamarlo, cuándo vencía y en qué terminó.
 * El PNG vive en MinIO y la firma vigente del usuario sigue siendo `users.signature_id`.
 *
 * `signatureFileId` responde "¿qué archivo produjo este intento?"; `users.signatureId` responde
 * "¿cuál es la firma que hay que usar hoy?". Son preguntas distintas y por eso son dos columnas:
 * si el usuario borra su firma y captura otra, el historial de intentos sigue apuntando cada uno
 * al archivo que generó, aunque ya no sea el vigente.
 */
@Entity('signature_capture_sessions')
/**
 * Una sola sesión activa por usuario, garantizado por la base y no sólo por el caso de uso.
 *
 * Es un índice único **parcial** (sólo sobre PENDING y CLAIMED) porque el historial sí admite
 * muchas filas terminales por usuario. Sin él, dos peticiones simultáneas —doble clic en
 * "Generar QR", dos pestañas abiertas— pasarían las dos la comprobación en memoria y dejarían
 * dos QR válidos al mismo tiempo para el mismo usuario.
 */
@Index('UQ_signature_capture_sessions_active_user', ['userId'], {
  unique: true,
  where: `"status" IN ('PENDING', 'CLAIMED')`,
})
/**
 * El token del QR se busca por su hash, así que el índice va sobre `token_hash`. Único —y
 * parcial, porque las sesiones DESKTOP no tienen token— para que dos sesiones nunca puedan
 * responder al mismo token.
 */
@Index('UQ_signature_capture_sessions_token_hash', ['tokenHash'], {
  unique: true,
  where: `"token_hash" IS NOT NULL`,
})
export class SignatureCaptureSessionEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /**
   * Dueño de la sesión. Sale **siempre** del token autenticado de quien la creó, nunca del
   * cuerpo de la petición: es la comparación contra este campo lo que impide que un tercero
   * reclame o firme una sesión ajena.
   */
  @Column({ name: 'user_id', type: 'uuid' })
  userId: string;

  @ManyToOne(() => UserEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: UserEntity;

  @Column({ type: 'enum', enum: SIGNATURE_CAPTURE_CHANNEL_ENUM })
  channel: SIGNATURE_CAPTURE_CHANNEL_ENUM;

  @Column({
    type: 'enum',
    enum: SIGNATURE_CAPTURE_SESSION_STATUS_ENUM,
    default: SIGNATURE_CAPTURE_SESSION_STATUS_ENUM.PENDING,
  })
  status: SIGNATURE_CAPTURE_SESSION_STATUS_ENUM;

  /**
   * SHA-256 del token que viaja dentro del QR. **El token en claro no se guarda en ningún lado**
   * y sólo se devuelve una vez, en la respuesta que crea la sesión: quien lea esta tabla —un
   * volcado de base, un backup, un log de consultas— no puede reconstruirlo ni usarlo.
   *
   * Null en las sesiones DESKTOP, que no necesitan token: el navegador que las creó ya viene
   * autenticado y opera sobre la sesión por su `id`.
   */
  @Column({ name: 'token_hash', type: 'varchar', nullable: true })
  tokenHash: string | null;

  /**
   * Vencimiento del intento. Corto a propósito (ver `SIGNATURE_CAPTURE_SESSION_TTL_MINUTES`): un
   * QR es un enlace de un solo uso que puede acabar fotografiado o compartido sin querer, y su
   * ventana de utilidad tiene que ser la mínima que le sirva a una persona real.
   */
  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt: Date;

  /** Cuándo canjeó el teléfono el token del QR. Null si nunca se reclamó. */
  @Column({ name: 'claimed_at', type: 'timestamptz', nullable: true })
  claimedAt: Date | null;

  /** Cuándo se guardó el PNG. Null si el intento no llegó a término. */
  @Column({ name: 'completed_at', type: 'timestamptz', nullable: true })
  completedAt: Date | null;

  /**
   * Firma que produjo este intento. `ON DELETE SET NULL` y no `CASCADE`: si el usuario borra esa
   * firma, el intento tiene que seguir en el historial —pasó, y consta cuándo y desde dónde—,
   * sólo que ya no apunta a ningún archivo.
   */
  @Column({ name: 'signature_file_id', type: 'uuid', nullable: true })
  signatureFileId: string | null;

  @ManyToOne(() => SignatureEntity, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'signature_file_id' })
  signatureFile: SignatureEntity | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
