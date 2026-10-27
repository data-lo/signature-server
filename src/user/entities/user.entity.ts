import { DocumentEntity } from 'src/document/entities/document.entity';
import { SignatureEntity } from 'src/signature/entities/signature.entity';
import { AccountEntity } from 'src/account/entities/account.entity';
import { PersonalInformationEntity } from './personal-information.entity';
import { SIGNING_CREDENTIAL_STATUS_ENUM } from '../enums/signing-credential-status.enum';
import { USER_LIFECYCLE_STATUS_ENUM } from '../enums/user-lifecycle-status.enum';
import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  OneToMany,
  OneToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity('users')
/**
 * Un usuario `ACTIVE` siempre tiene CURP, contraseña y ficha personal; sólo uno `PROVISIONED`
 * (creado por la API de integración) puede no tenerlos.
 */
@Check(
  'CHK_users_active_has_credentials',
  `"lifecycle_status" = 'PROVISIONED' OR ("password" IS NOT NULL AND "national_id" IS NOT NULL AND "personal_information_id" IS NOT NULL)`,
)
export class UserEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'first_name' })
  firstName: string;

  @Column({ name: 'last_name' })
  lastName: string;

  @Column({ unique: true, name: 'email' })
  email: string;

  @Column({ name: 'roles', type: 'simple-array' })
  roles: string[];

  @Column({ default: true, name: 'is_active' })
  isActive: boolean;

  @Column({ default: false, name: 'is_deleted' })
  isDeleted: boolean;

  @Column({ default: false, name: 'is_email_verified' })
  isEmailVerified: boolean;

  /**
   * Si el usuario se registró él mismo (`ACTIVE`) o lo aprovisionó una integración por API key
   * (`PROVISIONED`, sin CURP ni contraseña). Ver `USER_LIFECYCLE_STATUS_ENUM`.
   */
  @Column({
    type: 'enum',
    enum: USER_LIFECYCLE_STATUS_ENUM,
    default: USER_LIFECYCLE_STATUS_ENUM.ACTIVE,
    name: 'lifecycle_status',
  })
  lifecycleStatus: USER_LIFECYCLE_STATUS_ENUM;

  /** CURP. `null` sólo mientras el usuario está `PROVISIONED`. */
  @Index()
  @Column({ length: 18, name: 'national_id', unique: true, nullable: true })
  nationalId: string | null;

  /** Hash bcrypt. `null` sólo mientras el usuario está `PROVISIONED`: no puede iniciar sesión. */
  @Column({ name: 'password', type: 'varchar', nullable: true })
  password: string | null;

  @Column({ nullable: true, name: 'signature_id' })
  signatureId: string | null;

  /**
   * Estado global del avance de identidad y firma del usuario. Es la variable que los módulos
   * posteriores consultan antes de permitir una acción (subir la firma PNG, firmar un
   * documento), y la única fuente de verdad sobre ese avance.
   *
   * Sólo la escribe `UpdateSigningCredentialStatusUseCase`, que valida la transición: ningún
   * servicio, controller ni el frontend la tocan directamente. Los disparadores son eventos de
   * Didit (webhook), acciones del usuario sobre su firma y la regla de máximo de intentos.
   *
   * Es la única variable que decide si el usuario puede firmar con firma Simple. Sustituyó a la
   * antigua bandera `is_configured` (fin del onboarding general), que se eliminó en la depuración
   * de modelos deprecados.
   */
  @Column({
    type: 'enum',
    enum: SIGNING_CREDENTIAL_STATUS_ENUM,
    default: SIGNING_CREDENTIAL_STATUS_ENUM.IDENTITY_VERIFICATION_REQUIRED,
    name: 'signing_credential_status',
  })
  signingCredentialStatus: SIGNING_CREDENTIAL_STATUS_ENUM;

  /** Momento en que Didit aprobó la identidad del usuario. Null si nunca se aprobó. */
  @Column({ type: 'timestamp', nullable: true, name: 'identity_verified_at' })
  identityVerifiedAt: Date | null;

  /** Ficha personal (CURP, RFC). `null` sólo mientras el usuario está `PROVISIONED`. */
  @Column({ nullable: true, name: 'personal_information_id' })
  personalInformationId: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;

  @OneToOne(() => SignatureEntity)
  @JoinColumn({ name: 'signature_id' })
  signature: SignatureEntity | null;

  @OneToOne(() => PersonalInformationEntity)
  @JoinColumn({ name: 'personal_information_id' })
  personalInformation: PersonalInformationEntity | null;

  @OneToMany(() => DocumentEntity, (document) => document.requestedBy)
  createdDocuments: DocumentEntity[];

  @OneToMany(() => AccountEntity, (account) => account.user)
  accountMemberships: AccountEntity[];
}
