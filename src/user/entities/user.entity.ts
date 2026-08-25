import { DocumentEntity } from 'src/document/entities/document.entity';
import { SignatureEntity } from 'src/signature/entities/signature.entity';
import { AccountEntity } from 'src/account/entities/account.entity';
import { PersonalInformationEntity } from './personal-information.entity';
import { SIGNING_CREDENTIAL_STATUS_ENUM } from '../enums/signing-credential-status.enum';
import {
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

  @Column({ default: false, name: 'is_configured' })
  isConfigured: boolean;

  @Column({ default: false, name: 'is_email_verified' })
  isEmailVerified: boolean;

  @Index()
  @Column({ length: 18, name: 'national_id', unique: true })
  nationalId: string;

  @Column({ name: 'password' })
  password: string;

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
   * Distinta de `isConfigured`, que marca el fin del onboarding general (datos personales) y no
   * sabe nada de identidad validada.
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

  @Column({ nullable: false, name: 'personal_information_id' })
  personalInformationId: string;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;

  @OneToOne(() => SignatureEntity)
  @JoinColumn({ name: 'signature_id' })
  signature: SignatureEntity | null;

  @OneToOne(() => PersonalInformationEntity)
  @JoinColumn({ name: 'personal_information_id' })
  personalInformation: PersonalInformationEntity;

  @OneToMany(() => DocumentEntity, (document) => document.requestedBy)
  createdDocuments: DocumentEntity[];

  @OneToMany(() => AccountEntity, (account) => account.user)
  accountMemberships: AccountEntity[];
}
