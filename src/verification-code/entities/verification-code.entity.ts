import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from "typeorm";

@Entity('verification_codes')
export class VerificationCodeEntity {

    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column({ name: 'code' })
    code: string;

    @Column({ name: 'type' })
    type: string;

    @Column({ default: false, name: 'is_used' })
    isUsed: boolean;

    @Column({ nullable: true, name: 'used_at' })
    usedAt: Date;

    @Column({ nullable: true, name: 'ip_address' })
    ipAddress: string;

    @Column({ name: 'expired_at' })
    expiredAt: Date;

    @Column({ name: 'signer_id' })
    signerId: string;

    @Column({ name: 'document_id' })
    documentId: string;

    @CreateDateColumn({ name: 'created_at' })
    createdAt: Date;

    @UpdateDateColumn({ name: 'updated_at' })
    updatedAt: Date;    
}