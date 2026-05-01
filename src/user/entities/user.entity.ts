import { DocumentEntity } from "src/document/entities/document.entity";
import { SignatureEntity } from "src/signature/entities/signature.entity";
import { Column, CreateDateColumn, Entity, JoinColumn, OneToMany, OneToOne, PrimaryGeneratedColumn, UpdateDateColumn } from "typeorm";

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

    @Column({ nullable: true, name: 'position' })
    position: string;

    @Column({ name: 'roles', type: 'simple-array' })
    roles: string[];

    @Column({ default: true, name: 'is_active' })
    isActive: boolean;

    @Column({ length: 18, name: 'national_id' })
    nationalId: string;

    @Column({ nullable: true, name: 'signature_id' })
    signatureId: string;

    @CreateDateColumn({ name: 'created_at' })
    createdAt: Date;

    @UpdateDateColumn({ name: 'updated_at' })
    updatedAt: Date;

    @OneToOne(() => SignatureEntity)
    @JoinColumn({ name: 'signature_id' })
    signature: SignatureEntity;

    @OneToMany(() => DocumentEntity, (document) => document.requestedBy)
    createdDocuments: DocumentEntity[];

    @OneToMany(() => DocumentEntity, (document) => document.signer)
    documentsToSign: DocumentEntity[];
}
