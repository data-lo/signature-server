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

/**
 * Invitación individual de un firmante, la que abre la pantalla pública `/sign/:token` (ver
 * migración `CreateSigningInvitations`).
 *
 * No guarda el token: sólo su SHA-256. El token completo existe una sola vez, al emitirse, y lo
 * que lo identifica después es el hash. Así una copia de la base no sirve para abrir invitaciones.
 *
 * Una invitación está ABIERTA mientras no se haya revocado; sirve mientras además no haya vencido.
 * La base garantiza a lo sumo una abierta por colaborador (`UQ_signing_invitations_open`): emitir
 * otra revoca antes la anterior.
 */
@Entity('signing_invitations')
@Index('IDX_signing_invitations_collaborator', ['collaboratorId'])
@Index('UQ_signing_invitations_open', ['collaboratorId'], {
  unique: true,
  where: '"revoked_at" IS NULL',
})
export class SigningInvitationEntity {
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

  /** SHA-256 (hex) del token. Único: dos invitaciones nunca comparten token. */
  @Column({ name: 'token_hash', length: 64, unique: true })
  tokenHash: string;

  @Column({ name: 'issued_at', type: 'timestamptz' })
  issuedAt: Date;

  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt: Date;

  /** Cuándo dejó de valer antes de vencer: se emitió otra para el mismo firmante, o se retiró. */
  @Column({ name: 'revoked_at', type: 'timestamptz', nullable: true })
  revokedAt: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
