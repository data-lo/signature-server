import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { OrganizationEntity } from './organization.entity';
import { RoleEntity } from 'src/roles/entities/role.entity';
import { UserEntity } from 'src/user/entities/user.entity';
import { INVITATION_STATUS_ENUM } from '../enums/invitation-status.enum';

/**
 * Invitación pendiente a una organización (ver historia [STORY] Eventos Kafka, Email
 * (SendGrid) y Miembros (/join)). Antes, `POST /api/v1/organizations/invite` solo validaba y
 * respondía éxito sin persistir nada (alcance delimitado de su historia original) — esta tabla
 * es lo que cierra ese gap: un `token` único que el correo de invitación lleva en su enlace
 * (`/join?token=...&orgId=...`), resuelto sin JWT (el propio token es la credencial) para poder
 * aceptarse antes de que el invitado inicie sesión.
 */
@Entity('organization_invitations')
export class OrganizationInvitationEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'organization_id' })
  organizationId: string;

  @ManyToOne(() => OrganizationEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'organization_id' })
  organization: OrganizationEntity;

  @Column({ name: 'role_id' })
  roleId: string;

  @ManyToOne(() => RoleEntity)
  @JoinColumn({ name: 'role_id' })
  role: RoleEntity;

  /** Usuario (ADMIN de la organización) que envió la invitación. */
  @Column({ name: 'invited_by' })
  invitedBy: string;

  @ManyToOne(() => UserEntity)
  @JoinColumn({ name: 'invited_by' })
  invitedByUser: UserEntity;

  @Column()
  email: string;

  @Column({ unique: true })
  token: string;

  @Column({
    type: 'enum',
    enum: INVITATION_STATUS_ENUM,
    default: INVITATION_STATUS_ENUM.PENDING,
  })
  status: INVITATION_STATUS_ENUM;

  @Column({ name: 'expires_at' })
  expiresAt: Date;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
