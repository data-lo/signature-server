import { DocumentStatus } from "../lib/document-status";
import { SignatureCoordinates } from "../interfaces/signature-coordinates";
import { Column, CreateDateColumn, Entity, JoinColumn, ManyToOne, OneToOne, PrimaryGeneratedColumn, UpdateDateColumn } from "typeorm";
import { UserEntity } from "src/user/entities/user.entity";

// document.entity.ts
@Entity('documents')
export class DocumentEntity {

    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column({ name: 'object_key' })
    objectKey: string;

    @Column({ name: 'file_name' })
    fileName: string;

    @Column({ name: 'file_type' })
    fileType: string;

    @Column({ name: 'total_pages' })
    totalPages: number;

    @Column({ name: 'document_url' })
    documentUrl: string;

    @Column({ name: 'ip_address' })
    ipAddress: string;

    @Column({ name: 'verification_code_id', nullable: true })
    verificationCodeId: string;

    @Column({ name: 'original_hash' })
    originalHash: string;

    @Column({ name: 'signed_hash', nullable: true })
    signedHash: string;

    @Column({ name: 'signed_at', nullable: true })
    signedAt: Date;

    @Column({ name: 'is_notified', default: false })
    isNotified: boolean;

    @Column({
        name: 'status',
        type: 'enum',
        enum: DocumentStatus,
        default: DocumentStatus.CREATED,
    })
    status: DocumentStatus;

    @Column({ name: 'signature_coordinates', type: 'jsonb' })
    signatureCoordinates: SignatureCoordinates;

    @CreateDateColumn({ name: 'created_at' })
    createdAt: Date;

    @UpdateDateColumn({ name: 'updated_at' })
    updatedAt: Date;

    @Column({ name: 'created_by' })
    createdBy: string;


    @Column({ name: 'signer_id' })
    signerId: string;

    @ManyToOne(() => UserEntity, (user) => user.createdDocuments)
    @JoinColumn({ name: 'created_by' })
    requestedBy: UserEntity;

    @ManyToOne(() => UserEntity, (user) => user.documentsToSign)
    @JoinColumn({ name: 'signer_id' })
    signer: UserEntity;

}