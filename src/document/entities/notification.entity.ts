import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { DocumentEntity } from './document.entity';
import { CollaboratorEntity } from './collaborator.entity';
import { ACTOR_TYPE_ENUM } from '../enum/actor-type.enum';
import { NOTIFICATION_CHANNEL_ENUM } from '../enum/notification-channel.enum';

/**
 * Registra los envíos de correo del ciclo de vida del documento, que hasta la Fase 6 eran
 * fire-and-forget: ya ocurrían, pero no quedaba constancia de que hubieran ocurrido.
 *
 * Se escribe desde `DocumentEventsConsumer` (Kafka) y no desde `document.service.ts`: el envío
 * inline por `EmailService` se mantiene por inmediatez, y esta tabla es sólo su registro, no el
 * mecanismo de envío.
 *
 * `collaboratorId` es nullable porque algunos avisos van al creador del documento, que no siempre
 * tiene fila de Collaborator.
 */
@Entity('notifications')
export class NotificationEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'collaborator_id', nullable: true })
  collaboratorId: string | null;

  @ManyToOne(() => CollaboratorEntity, { nullable: true, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'collaborator_id' })
  collaborator: CollaboratorEntity | null;

  @Column({ default: false, name: 'is_notified' })
  isNotified: boolean;

  @Column({
    name: 'actor_type',
    type: 'enum',
    enum: ACTOR_TYPE_ENUM,
  })
  actorType: ACTOR_TYPE_ENUM;

  @Column({ name: 'document_id' })
  documentId: string;

  @ManyToOne(() => DocumentEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'document_id' })
  document: DocumentEntity;

  @Column({
    name: 'notification_channel_source',
    type: 'enum',
    enum: NOTIFICATION_CHANNEL_ENUM,
    default: NOTIFICATION_CHANNEL_ENUM.EMAIL,
  })
  notificationChannelSource: NOTIFICATION_CHANNEL_ENUM;

  @Column({ default: false })
  delivered: boolean;

  @Column({ nullable: true, name: 'sent_at' })
  sentAt: Date | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
