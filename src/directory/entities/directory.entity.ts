import {
  Check,
  CreateDateColumn,
  Column,
  Entity,
  JoinColumn,
  OneToMany,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';
import { AccountEntity } from 'src/account/entities/account.entity';
import { OrganizationEntity } from 'src/account/entities/organization.entity';
import { DirectoryContactEntity } from './directory-contact.entity';

/**
 * El directorio de contactos de una cuenta activa.
 *
 * El dueño depende del tipo de cuenta, y siempre es exactamente uno:
 * - **PERSONAL**: `personalAccountId`, el `AccountEntity.id` de la cuenta personal (1:1 con el
 *   usuario).
 * - **ORGANIZATION**: `organizationId`, la organización y NO la membresía. Cada miembro tiene su
 *   propia fila en `accounts`; colgar el directorio de ella daría un directorio por usuario en vez
 *   de uno compartido por la organización.
 *
 * Las dos columnas son únicas: a lo sumo un directorio por cuenta personal y uno por organización.
 * `CHK_directories_single_owner` exige que una, y sólo una, esté presente.
 *
 * Las relaciones con el dueño se declaran `ManyToOne` + `@Unique` y no `OneToOne`: éste crea su
 * restricción con un nombre generado (`REL_<hash>`) que no se puede fijar, y el esquema lo
 * gobiernan las migraciones con nombres explícitos.
 */
@Entity('directories')
@Unique('UQ_directories_personal_account_id', ['personalAccountId'])
@Unique('UQ_directories_organization_id', ['organizationId'])
@Check(
  'CHK_directories_single_owner',
  `("personal_account_id" IS NOT NULL AND "organization_id" IS NULL) OR ("personal_account_id" IS NULL AND "organization_id" IS NOT NULL)`,
)
export class DirectoryEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** Cuenta personal dueña del directorio; `null` en el directorio de una organización. */
  @Column({ name: 'personal_account_id', type: 'uuid', nullable: true })
  personalAccountId: string | null;

  /**
   * Debe ser una cuenta de tipo `PERSONAL`; lo valida quien crea el directorio, no la base.
   * `CASCADE`: el directorio no tiene sentido sin su dueño.
   */
  @ManyToOne(() => AccountEntity, { nullable: true, onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'personal_account_id',
    foreignKeyConstraintName: 'FK_directories_personal_account_id',
  })
  personalAccount?: AccountEntity | null;

  /** Organización dueña del directorio; `null` en el directorio de una cuenta personal. */
  @Column({ name: 'organization_id', type: 'uuid', nullable: true })
  organizationId: string | null;

  /** `CASCADE`, igual que `accounts.organization_id`: borrar la organización borra su directorio. */
  @ManyToOne(() => OrganizationEntity, { nullable: true, onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'organization_id',
    foreignKeyConstraintName: 'FK_directories_organization_id',
  })
  organization?: OrganizationEntity | null;

  @OneToMany(() => DirectoryContactEntity, (contact) => contact.directory)
  contacts: DirectoryContactEntity[];

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
