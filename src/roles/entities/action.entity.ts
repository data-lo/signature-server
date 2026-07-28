import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('actions')
export class ActionEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'key', unique: true })
  key: string;

  @Column({ name: 'description' })
  description: string;
}
