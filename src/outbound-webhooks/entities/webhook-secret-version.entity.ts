import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';

import { WebhookEndpointEntity } from './webhook-endpoint.entity';

/**
 * Una versión del secreto HMAC de un endpoint, cifrada.
 *
 * - `UQ_webhook_secret_versions_active` (índice parcial) admite como máximo una versión sin
 *   `retired_at` por endpoint: es la que firma las entregas nuevas.
 * - Rotar retira la activa y crea la siguiente en una misma transacción. La retirada no se borra:
 *   las entregas registradas antes de la rotación la referencian (`secret_version_id`) y siguen
 *   firmándose con ella hasta terminar.
 * - `UQ_webhook_secret_versions_id_endpoint` existe para la FK compuesta de `webhook_deliveries`,
 *   que garantiza que una entrega se firma con un secreto de su mismo endpoint.
 */
@Entity('webhook_secret_versions')
@Index(
  'UQ_webhook_secret_versions_endpoint_version',
  ['endpointId', 'version'],
  {
    unique: true,
  },
)
@Index('UQ_webhook_secret_versions_active', ['endpointId'], {
  unique: true,
  where: '"retired_at" IS NULL',
})
@Index('UQ_webhook_secret_versions_id_endpoint', ['id', 'endpointId'], {
  unique: true,
})
@Check('CHK_webhook_secret_versions_version', `"version" >= 1`)
export class WebhookSecretVersionEntity {
  @PrimaryGeneratedColumn('uuid', {
    primaryKeyConstraintName: 'PK_webhook_secret_versions',
  })
  id: string;

  @Column({ name: 'endpoint_id', type: 'uuid' })
  endpointId: string;

  @ManyToOne(
    () => WebhookEndpointEntity,
    (endpoint) => endpoint.secretVersions,
    {
      onDelete: 'RESTRICT',
    },
  )
  @JoinColumn({
    name: 'endpoint_id',
    foreignKeyConstraintName: 'FK_webhook_secret_versions_endpoint_id',
  })
  endpoint?: WebhookEndpointEntity;

  /** Consecutivo por endpoint, desde 1. */
  @Column({ type: 'int' })
  version: number;

  /** Secreto cifrado por `WebhookSecretCipherService`; nunca se devuelve por la API. */
  @Column({ name: 'encrypted_secret', type: 'text' })
  encryptedSecret: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  /** Cuándo la reemplazó otra versión; `null` en la activa. */
  @Column({ name: 'retired_at', type: 'timestamptz', nullable: true })
  retiredAt: Date | null;
}
