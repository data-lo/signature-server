import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { ACCOUNT_TYPE_ENUM } from '../enums/account-type.enum';
import { ACCOUNT_STATUS_ENUM } from '../enums/account-status.enum';
import { OrganizationEntity } from './organization.entity';
import { UserEntity } from 'src/user/entities/user.entity';
import { RoleEntity } from 'src/roles/entities/role.entity';

/**
 * Fila única por (usuario × contexto): fusiona el antiguo tenant (PERSONAL u ORGANIZATION) con la
 * membresía usuario↔cuenta, según el diagrama ER-V2 (Fase 5, decisión D5).
 *
 * En PERSONAL no hay ambigüedad (1 usuario = 1 fila = el tenant). En ORGANIZATION cada miembro tiene
 * su fila, todas con el mismo `organizationId` → una fila de `OrganizationEntity`, que es la
 * identidad real del tenant. El aislamiento multi-tenant se apoya en
 * `Document.organizationId`/`AccountSubscription.organizationId`; en contexto personal basta el
 * `id` de esta fila, única por usuario.
 *
 * `email`/`password` son una copia sincronizada de la credencial única del usuario (decisión D6):
 * no hay contraseñas independientes por organización. `UserEntity` sigue siendo la fuente primaria
 * para búsqueda y notificaciones, para no reescribir el dominio de documentos en la misma migración.
 */
@Entity('accounts')
export class AccountEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'user_id' })
  userId: string;

  @ManyToOne(() => UserEntity)
  @JoinColumn({ name: 'user_id' })
  user: UserEntity;

  @Column({ name: 'account_type', type: 'enum', enum: ACCOUNT_TYPE_ENUM })
  accountType: ACCOUNT_TYPE_ENUM;

  /** NULL para cuentas PERSONAL. */
  @Column({ name: 'organization_id', nullable: true })
  organizationId: string | null;

  @ManyToOne(() => OrganizationEntity, { nullable: true, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'organization_id' })
  organization: OrganizationEntity | null;

  /** NULL solo si a la membresía todavía no se le asignó un rol (reservado para un futuro flujo de invitación). */
  @Column({ name: 'role_id', nullable: true })
  roleId: string | null;

  @ManyToOne(() => RoleEntity, { nullable: true })
  @JoinColumn({ name: 'role_id' })
  role: RoleEntity | null;

  /**
   * Referencia a AccountSubscriptionEntity (ver D2 del plan) — sin FK en base de datos a
   * propósito: account_subscriptions.account_id ya referencia a accounts.id, y una FK en ambos
   * sentidos crearía una dependencia circular. Se resuelve en aplicación, no en el schema.
   */
  @Column({ name: 'membership_id', nullable: true })
  membershipId: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @Column({
    type: 'enum',
    enum: ACCOUNT_STATUS_ENUM,
    default: ACCOUNT_STATUS_ENUM.ACTIVE,
  })
  status: ACCOUNT_STATUS_ENUM;

  /** Sincronizado desde UserEntity.email (una sola credencial por usuario, ver decisión D6). */
  @Column()
  email: string;

  /** Sincronizado desde UserEntity.password (hash bcrypt). */
  @Column()
  password: string;

  @Column({ default: true, name: 'is_active' })
  isActive: boolean;

  @Column({ nullable: true, name: 'left_at' })
  leftAt: Date | null;

  @Column({ nullable: true, name: 'joined_at' })
  joinedAt: Date | null;

  @Column({ default: false, name: 'index_documents' })
  indexDocuments: boolean;

  @Column({ nullable: true })
  position: string | null;
}
