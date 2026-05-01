import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from "typeorm";

@Entity('users')
export class UserEntity {

    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column()
    firstName: string;

    @Column()
    lastName: string;

    @Column({ unique: true })
    email: string;

    @Column({ nullable: true })
    position: string;

    @Column()
    signatureId: string;

    @Column('simple-array')
    roles: string[];

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

    @Column({
        length: 18
    })
    nationalId: string;
}
