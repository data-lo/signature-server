import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

import { OUTBOUND_WEBHOOK_EVENT_TYPE_ENUM } from '../enums/outbound-webhook-event-type.enum';
import { WEBHOOK_ENDPOINT_STATUS_ENUM } from '../enums/webhook-endpoint-status.enum';
import { WEBHOOK_SUBJECT_TYPE_ENUM } from '../enums/webhook-subject-type.enum';
import { WebhookSecretVersionEntity } from './webhook-secret-version.entity';

/**
 * Destino de los webhooks salientes de un sujeto (hoy, una organización).
 *
 * El sujeto es polimórfico: `subjectType` dice a qué tabla apunta `subjectId`, y por eso no hay FK.
 * La aplicación valida que el sujeto exista y que quien configura tenga permiso sobre él.
 * `UQ_webhook_endpoints_subject` limita a un endpoint por sujeto; habilitar varios es una migración.
 *
 * El secreto no vive aquí sino en `webhook_secret_versions`, para poder rotarlo sin perder la
 * versión con la que se firmaron las entregas ya registradas.
 */
@Entity('webhook_endpoints')
@Index('UQ_webhook_endpoints_subject', ['subjectType', 'subjectId'], {
  unique: true,
})
@Check(
  'CHK_webhook_endpoints_subject_type',
  `"subject_type" IN ('ORGANIZATION')`,
)
@Check('CHK_webhook_endpoints_status', `"status" IN ('ACTIVE', 'DISABLED')`)
@Check(
  'CHK_webhook_endpoints_disabled_at',
  `("status" = 'DISABLED') = ("disabled_at" IS NOT NULL)`,
)
@Check(
  'CHK_webhook_endpoints_subscribed_event_types',
  `cardinality("subscribed_event_types") > 0 AND "subscribed_event_types" <@ ARRAY['document.collaborator_signed', 'document.signed', 'document.rejected', 'document.cancelled']::text[]`,
)
export class WebhookEndpointEntity {
  @PrimaryGeneratedColumn('uuid', {
    primaryKeyConstraintName: 'PK_webhook_endpoints',
  })
  id: string;

  @Column({ name: 'subject_type', type: 'varchar', length: 50 })
  subjectType: WEBHOOK_SUBJECT_TYPE_ENUM;

  /** Id del sujeto en la tabla que indica `subjectType` (`organizations.id`). */
  @Column({ name: 'subject_id', type: 'uuid' })
  subjectId: string;

  /** URL HTTPS a la que se envían las entregas nuevas; las ya registradas guardan la suya. */
  @Column({ type: 'text' })
  url: string;

  @Column({
    type: 'varchar',
    length: 20,
    default: WEBHOOK_ENDPOINT_STATUS_ENUM.ACTIVE,
  })
  status: WEBHOOK_ENDPOINT_STATUS_ENUM;

  /** Eventos que generan entregas; al menos uno. */
  @Column({ name: 'subscribed_event_types', type: 'text', array: true })
  subscribedEventTypes: OUTBOUND_WEBHOOK_EVENT_TYPE_ENUM[];

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;

  /** Cuándo se desactivó; `null` mientras está `ACTIVE`. */
  @Column({ name: 'disabled_at', type: 'timestamptz', nullable: true })
  disabledAt: Date | null;

  @OneToMany(() => WebhookSecretVersionEntity, (version) => version.endpoint)
  secretVersions?: WebhookSecretVersionEntity[];
}
