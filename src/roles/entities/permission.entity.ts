import {
  Column,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';
import { ResourceEntity } from './resource.entity';
import { ActionEntity } from './action.entity';

@Entity('permissions')
@Unique(['resourceId', 'actionId', 'scope'])
export class PermissionEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'resource_id' })
  resourceId: string;

  @Column({ name: 'action_id' })
  actionId: string;

  @Column({ name: 'scope' })
  scope: string;

  @ManyToOne(() => ResourceEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'resource_id' })
  resource: ResourceEntity;

  @ManyToOne(() => ActionEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'action_id' })
  action: ActionEntity;
}
