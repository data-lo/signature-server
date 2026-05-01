import { UserEntity } from "src/user/entities/user.entity";
import { Column, CreateDateColumn, Entity, JoinColumn, OneToOne, PrimaryGeneratedColumn, UpdateDateColumn } from "typeorm";

@Entity('signatures')
export class SignatureEntity {

    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column()
    firstName: string;

    @Column()
    lastName: string;

    @Column({ nullable: true })
    createdBy: string | null;

    @Column()
    signatureObjectKey: string;

    @Column()
    officialCardObjectKey: string;

    @Column({ default: true })
    isActive: boolean;

    @CreateDateColumn({
        utc: true
    })
    createdAt: Date;

    @UpdateDateColumn({
        utc: true
    })
    updatedAt: Date;

    @OneToOne(() => UserEntity, (user) => user.signature)
    user: UserEntity
}