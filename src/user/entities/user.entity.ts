import { DocumentEntity } from 'src/document/entities/document.entity';
import { DocumentParticipantEntity } from 'src/document/entities/document-participant.entity';
import { SignatureEntity } from 'src/signature/entities/signature.entity';
import { AccountMemberEntity } from 'src/account/entities/account-member.entity';
import { PersonalInformationEntity } from './personal-information.entity';
import {
  Column,
  CreateDateColumn,
  Entity,
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

  @Column({ nullable: false, name: 'position' })
  position: string;

  @Column({ name: 'roles', type: 'simple-array' })
  roles: string[];

  @Column({ default: true, name: 'is_active' })
  isActive: boolean;

  @Column({ default: false, name: 'is_deleted' })
  isDeleted: boolean;

  @Column({ length: 18, name: 'national_id', unique: true })
  nationalId: string;

  @Column({ name: 'password' })
  password: string;

  @Column({ nullable: true, name: 'signature_id' })
  signatureId: string | null;

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

  @OneToMany(() => DocumentParticipantEntity, (participant) => participant.user)
  documentsToSign: DocumentParticipantEntity[];

  @OneToMany(() => AccountMemberEntity, (member) => member.user)
  accountMemberships: AccountMemberEntity[];
}
