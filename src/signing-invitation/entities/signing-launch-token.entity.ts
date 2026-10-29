import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';

import { SigningInvitationEntity } from './signing-invitation.entity';

/**
 * Acceso temporal a la invitación de un firmante, emitido para el portal del tercero que creó el
 * documento (`POST /integration/documents/:documentId/signing-access`) y abierto en
 * `/sign/launch/:token` (ver migración `CreateSigningLaunchTokens`).
 *
 * Como la invitación, no guarda el token, sólo su SHA-256. A diferencia de ella, vive minutos y se
 * usa una sola vez (`consumedAt`). Canjearlo no autoriza la firma: lleva a la validación del código
 * enviado al correo de la invitación.
 */
@Entity('signing_launch_tokens')
@Index('IDX_signing_launch_tokens_invitation', ['invitationId'])
export class SigningLaunchTokenEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'invitation_id' })
  invitationId: string;

  @ManyToOne(() => SigningInvitationEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'invitation_id' })
  invitation: SigningInvitationEntity;

  /** SHA-256 (hex) del token. */
  @Column({ name: 'token_hash', length: 64, unique: true })
  tokenHash: string;

  @Column({ name: 'issued_at', type: 'timestamptz' })
  issuedAt: Date;

  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt: Date;

  /** Cuándo se canjeó. Un token canjeado no vuelve a servir. */
  @Column({ name: 'consumed_at', type: 'timestamptz', nullable: true })
  consumedAt: Date | null;

  /** API key con la que el tercero lo pidió (trazabilidad). */
  @Column({ name: 'issued_via_api_key_id', type: 'uuid', nullable: true })
  issuedViaApiKeyId: string | null;

  /** IP del backend del tercero que lo pidió. */
  @Column({ name: 'issued_ip_address', type: 'varchar', nullable: true })
  issuedIpAddress: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
