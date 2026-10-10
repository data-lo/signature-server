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
import { AccountEntity } from 'src/account/entities/account.entity';
import { DirectoryEntity } from './directory.entity';

/**
 * Un contacto dentro de un directorio.
 *
 * Es una libreta de direcciones, no una identidad: un contacto puede ser alguien externo que aún
 * no tiene cuenta en la plataforma (`linkedPersonalAccountId` en `null`). Tampoco se relaciona con
 * `CollaboratorEntity`: el documento guarda su propio snapshot del firmante, y editar o archivar
 * el contacto no puede alterar documentos ya enviados.
 *
 * `UQ_directory_contacts_directory_email`: un correo aparece una sola vez por directorio. Se
 * compara sobre `emailNormalized`, que normaliza quien escribe el contacto (fuera del alcance de
 * esta entidad). Cubre también los archivados: volver a dar de alta un correo archivado debe
 * reactivar esa fila, no insertar una segunda.
 */
@Entity('directory_contacts')
@Unique('UQ_directory_contacts_directory_email', [
  'directoryId',
  'emailNormalized',
])
@Index('IDX_directory_contacts_linked_personal_account_id', [
  'linkedPersonalAccountId',
])
export class DirectoryContactEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'directory_id', type: 'uuid' })
  directoryId: string;

  @ManyToOne(() => DirectoryEntity, (directory) => directory.contacts, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({
    name: 'directory_id',
    foreignKeyConstraintName: 'FK_directory_contacts_directory_id',
  })
  directory: DirectoryEntity;

  @Column({ name: 'email_normalized', type: 'varchar' })
  emailNormalized: string;

  @Column({ name: 'first_name', type: 'varchar' })
  firstName: string;

  @Column({ name: 'last_name', type: 'varchar' })
  lastName: string;

  /**
   * Identificador fiscal (en México, el RFC), en mayúsculas. Opcional: no todo contacto lo da.
   * Desde `AddTaxIdAndPhoneToDirectoryContacts1784300000072`.
   */
  @Column({ name: 'tax_id', type: 'varchar', nullable: true })
  taxId: string | null;

  /** Teléfono tal como se capturó, sin espacios en los extremos. Opcional. */
  @Column({ name: 'phone', type: 'varchar', nullable: true })
  phone: string | null;

  /** Cuenta personal de la plataforma que corresponde a este contacto; `null` si es externo. */
  @Column({ name: 'linked_personal_account_id', type: 'uuid', nullable: true })
  linkedPersonalAccountId: string | null;

  /**
   * Debe ser una cuenta de tipo `PERSONAL`; lo valida el caso de uso, no la base. `SET NULL`: si
   * la cuenta desaparece, el contacto sigue siendo válido como externo.
   */
  @ManyToOne(() => AccountEntity, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({
    name: 'linked_personal_account_id',
    foreignKeyConstraintName:
      'FK_directory_contacts_linked_personal_account_id',
  })
  linkedPersonalAccount?: AccountEntity | null;

  /** Membresía (no usuario) que dio de alta el contacto: en una organización, qué miembro fue. */
  @Column({ name: 'created_by_account_id', type: 'uuid', update: false })
  createdByAccountId: string;

  @ManyToOne(() => AccountEntity)
  @JoinColumn({
    name: 'created_by_account_id',
    foreignKeyConstraintName: 'FK_directory_contacts_created_by_account_id',
  })
  createdByAccount: AccountEntity;

  /** Membresía que hizo el último cambio; al crear, la misma que `createdByAccountId`. */
  @Column({ name: 'updated_by_account_id', type: 'uuid' })
  updatedByAccountId: string;

  @ManyToOne(() => AccountEntity)
  @JoinColumn({
    name: 'updated_by_account_id',
    foreignKeyConstraintName: 'FK_directory_contacts_updated_by_account_id',
  })
  updatedByAccount: AccountEntity;

  /** Borrado lógico, todavía sin implementar: `null` mientras el contacto está vigente. */
  @Column({ name: 'archived_at', type: 'timestamptz', nullable: true })
  archivedAt: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
