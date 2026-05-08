import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('logs')
export class LogEntity {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column({ type: 'text' })
    log: string;

    @CreateDateColumn({ name: 'timestamp' })
    timestamp: Date;
}
