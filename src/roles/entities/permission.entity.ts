import {
  Column,
  Entity,
  JoinColumn,
  ManyToMany,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';
import { ResourceEntity } from './resource.entity';
import { ActionEntity } from './action.entity';
import { ApiKeyEntity } from 'src/api-key/entities/api-key.entity';

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

  /**
   * API keys que tienen concedido este permiso (`api_key_permissions`).
   *
   * `RESTRICT`: un permiso asignado a alguna llave no se puede borrar; primero hay que quitárselo.
   */
  @ManyToMany(() => ApiKeyEntity, (apiKey) => apiKey.permissions, {
    onDelete: 'RESTRICT',
    onUpdate: 'NO ACTION',
  })
  apiKeys: ApiKeyEntity[];
}
