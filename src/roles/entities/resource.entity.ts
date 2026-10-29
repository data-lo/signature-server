import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('resources')
export class ResourceEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'key', unique: true })
  key: string;

  @Column({ name: 'description' })
  description: string;
}
