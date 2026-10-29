import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { CollaboratorEntity } from 'src/document/entities/collaborator.entity';
import { NotificationEntity } from 'src/document/entities/notification.entity';
import { COLABORATOR_TYPE_ENUM } from 'src/document/enum/colaborator-type.enum';
import { ACTOR_TYPE_ENUM } from 'src/document/enum/actor-type.enum';
import { NOTIFICATION_CHANNEL_ENUM } from 'src/document/enum/notification-channel.enum';

/**
 * Persistencia de la constancia de notificación que dejan los eventos del ciclo de vida del
 * documento.
 *
 * El envío del correo real sigue siendo inline y síncrono en los casos de uso de documentos
 * (decisión del plan de migración ER-V2, Fase 6): estas filas no disparan correos, sólo dejan
 * registrado que el evento ocurrió y a quién le tocaba enterarse. Escribirlas por Kafka —y no
 * dentro de la transición de estado— las vuelve eventuales respecto de la firma, que es
 * justamente lo que se quería: la auditoría de notificaciones no debe poder frenar una firma.
 */
@Injectable()
export class DocumentEventNotificationsService {
  constructor(
    @InjectRepository(NotificationEntity)
    private readonly notificationRepository: Repository<NotificationEntity>,
    @InjectRepository(CollaboratorEntity)
    private readonly collaboratorRepository: Repository<CollaboratorEntity>,
  ) {}

  /** Todos los colaboradores de un documento, sin distinguir su papel. */
  async findCollaborators(documentId: string): Promise<CollaboratorEntity[]> {
    return this.collaboratorRepository.find({ where: { documentId } });
  }

  /** Sólo los firmantes de un documento. */
  async findSigners(documentId: string): Promise<CollaboratorEntity[]> {
    return this.collaboratorRepository.find({
      where: { documentId, colaboratorType: COLABORATOR_TYPE_ENUM.SIGNER },
    });
  }

  /**
   * Un registro por colaborador. El `actorType` sale de si el colaborador tiene cuenta o fue
   * invitado sólo por correo: son dos formas distintas de participar y la auditoría necesita
   * distinguirlas.
   */
  async persistForCollaborators(
    documentId: string,
    collaborators: CollaboratorEntity[],
  ): Promise<void> {
    if (collaborators.length === 0) {
      return;
    }

    const rows = collaborators.map((collaborator) =>
      this.notificationRepository.create({
        collaboratorId: collaborator.id,
        documentId,
        isNotified: true,
        actorType: collaborator.accountId
          ? ACTOR_TYPE_ENUM.ACCOUNT
          : ACTOR_TYPE_ENUM.WATCHER,
        notificationChannelSource: NOTIFICATION_CHANNEL_ENUM.EMAIL,
        delivered: true,
        sentAt: new Date(),
      }),
    );

    await this.notificationRepository.save(rows);
  }

  /**
   * Constancia dirigida al creador del documento, que no siempre tiene fila de colaborador —
   * por eso se guarda sin `collaboratorId` (ver `NotificationEntity`).
   */
  async persistForCreator(documentId: string): Promise<void> {
    await this.notificationRepository.save(
      this.notificationRepository.create({
        collaboratorId: null,
        documentId,
        isNotified: true,
        actorType: ACTOR_TYPE_ENUM.ACCOUNT,
        notificationChannelSource: NOTIFICATION_CHANNEL_ENUM.EMAIL,
        delivered: true,
        sentAt: new Date(),
      }),
    );
  }
}
