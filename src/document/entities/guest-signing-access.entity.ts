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
import { DocumentEntity } from './document.entity';
import { CollaboratorEntity } from './collaborator.entity';
import { GUEST_SIGNING_ACCESS_PURPOSE_ENUM } from '../enum/guest-signing-access-purpose.enum';

/**
 * Acceso temporal de un invitado SIN cuenta a la firma de un documento, emitido cuando valida el
 * código enviado al correo de su invitación (ver migración `CreateGuestSigningAccesses`).
 *
 * El `id` es el `jti` del token que recibe el invitado: el token sólo lo identifica, y lo que
 * decide si sirve es esta fila. Así se puede revocar o consumir un token ya entregado, cosa que
 * un JWT por sí solo no permite.
 *
 * Un acceso está ACTIVO mientras no haya vencido, ni se haya consumido, ni se haya revocado. La
 * base garantiza a lo sumo uno abierto (sin consumir ni revocar) por documento + colaborador +
 * propósito (`UQ_guest_signing_accesses_open`); emitir uno nuevo revoca antes los anteriores.
 *
 * No guarda el correo ni el token: sólo el hash del correo normalizado, para detectar que la
 * invitación cambió de destinatario después de emitido el acceso.
 */
@Entity('guest_signing_accesses')
@Index('IDX_guest_signing_accesses_collaborator', ['collaboratorId'])
@Index(
  'UQ_guest_signing_accesses_open',
  ['documentId', 'collaboratorId', 'purpose'],
  { unique: true, where: '"consumed_at" IS NULL AND "revoked_at" IS NULL' },
)
export class GuestSigningAccessEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'document_id' })
  documentId: string;

  @ManyToOne(() => DocumentEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'document_id' })
  document: DocumentEntity;

  @Column({ name: 'collaborator_id' })
  collaboratorId: string;

  @ManyToOne(() => CollaboratorEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'collaborator_id' })
  collaborator: CollaboratorEntity;

  /** SHA-256 (hex) del correo de la invitación en minúsculas y sin espacios. */
  @Column({ name: 'email_hash', length: 64 })
  emailHash: string;

  @Column({ type: 'enum', enum: GUEST_SIGNING_ACCESS_PURPOSE_ENUM })
  purpose: GUEST_SIGNING_ACCESS_PURPOSE_ENUM;

  @Column({ name: 'issued_at', type: 'timestamptz' })
  issuedAt: Date;

  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt: Date;

  /** Cuándo se usó para registrar la firma. Un acceso consumido no vuelve a servir. */
  @Column({ name: 'consumed_at', type: 'timestamptz', nullable: true })
  consumedAt: Date | null;

  /**
   * Cuándo dejó de valer sin haberse usado: se emitió otro, el colaborador vinculó una cuenta, o
   * el documento se firmó, rechazó o canceló.
   */
  @Column({ name: 'revoked_at', type: 'timestamptz', nullable: true })
  revokedAt: Date | null;

  /** IP desde la que se validó el código que dio origen a este acceso. */
  @Column({ name: 'issued_ip_address', type: 'varchar', nullable: true })
  issuedIpAddress: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
