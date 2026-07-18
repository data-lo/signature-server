import { Controller, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { EventPattern, Payload } from '@nestjs/microservices';
import {
  DOCUMENT_KAFKA_TOPICS,
  DocumentEventPayload,
} from './document-events.topics';
import { NotificationEntity } from 'src/document/entities/notification.entity';
import { CollaboratorEntity } from 'src/document/entities/collaborator.entity';
import { COLABORATOR_TYPE_ENUM } from 'src/document/enum/colaborator-type.enum';
import { ACTOR_TYPE_ENUM } from 'src/document/enum/actor-type.enum';
import { NOTIFICATION_CHANNEL_ENUM } from 'src/document/enum/notification-channel.enum';
import { getNextPendingSigner } from 'src/document/utils/next-signer.util';

/**
 * Consumidor real de los eventos de negocio del ciclo de vida del documento (ver
 * DocumentEventsProducer). Desde la Fase 6 del plan de migración ER-V2, además de loguear
 * cada evento, persiste un registro de Notification por cada colaborador que ya recibió (o
 * debió recibir) un correo en document.service.ts para ese mismo evento.
 *
 * Decisión (ver plan): el envío de correo real sigue siendo inline y síncrono en
 * document.service.ts (EmailService, inmediato) — este consumer NO reenvía correos, solo dejó
 * constancia de que el evento ocurrió y a quién le tocaba ser notificado. Escribir el registro
 * aquí (en vez de en document.service.ts) es async/eventual respecto a la transición de
 * estado, una diferencia de comportamiento intencional para no acoplar el flujo de firma a la
 * persistencia de auditoría de notificaciones.
 */
@Controller()
export class DocumentEventsConsumer {
  private readonly logger = new Logger(DocumentEventsConsumer.name);

  constructor(
    @InjectRepository(NotificationEntity)
    private readonly notificationRepository: Repository<NotificationEntity>,
    @InjectRepository(CollaboratorEntity)
    private readonly collaboratorRepository: Repository<CollaboratorEntity>,
  ) {}

  @EventPattern(DOCUMENT_KAFKA_TOPICS.CREATED)
  handleCreated(@Payload() payload: DocumentEventPayload) {
    // Sin correo enviado en la creación (ver document.service.ts create()) — nada que persistir.
    this.logEvent('creado', payload);
  }

  @EventPattern(DOCUMENT_KAFKA_TOPICS.SENT_TO_SIGN)
  async handleSentToSign(@Payload() payload: DocumentEventPayload) {
    this.logEvent('enviado a firma', payload);
    await this.safely(async () => {
      const signers = await this.collaboratorRepository.find({
        where: {
          documentId: payload.documentId,
          colaboratorType: COLABORATOR_TYPE_ENUM.SIGNER,
        },
      });
      const nextSigner = getNextPendingSigner(signers);
      if (nextSigner) {
        await this.persistNotifications(payload.documentId, [nextSigner]);
      }
    }, payload);
  }

  @EventPattern(DOCUMENT_KAFKA_TOPICS.SIGNED)
  async handleSigned(@Payload() payload: DocumentEventPayload) {
    // emitSigned solo se dispara cuando el documento queda completamente firmado (ver sign()
    // en document.service.ts) — corresponde exactamente a sendCompletionEmails a TODOS.
    this.logEvent('firmado', payload);
    await this.safely(async () => {
      const collaborators = await this.collaboratorRepository.find({
        where: { documentId: payload.documentId },
      });
      await this.persistNotifications(payload.documentId, collaborators);
    }, payload);
  }

  @EventPattern(DOCUMENT_KAFKA_TOPICS.REJECTED)
  async handleRejected(@Payload() payload: DocumentEventPayload) {
    // sendDocumentRejectedNotification solo notifica al creador, que no siempre tiene una fila
    // de Collaborator — se persiste sin collaboratorId (ver NotificationEntity).
    this.logEvent('rechazado', payload);
    await this.safely(
      () => this.persistCreatorNotification(payload.documentId),
      payload,
    );
  }

  @EventPattern(DOCUMENT_KAFKA_TOPICS.CANCELLATION_REQUESTED)
  async handleCancellationRequested(@Payload() payload: DocumentEventPayload) {
    this.logEvent('cancelación solicitada', payload);
    await this.safely(async () => {
      const signers = await this.collaboratorRepository.find({
        where: {
          documentId: payload.documentId,
          colaboratorType: COLABORATOR_TYPE_ENUM.SIGNER,
        },
      });
      await this.persistNotifications(payload.documentId, signers);
    }, payload);
  }

  @EventPattern(DOCUMENT_KAFKA_TOPICS.CANCELLED)
  async handleCancelled(@Payload() payload: DocumentEventPayload) {
    this.logEvent('cancelado', payload);
    await this.safely(async () => {
      const collaborators = await this.collaboratorRepository.find({
        where: { documentId: payload.documentId },
      });
      await this.persistNotifications(payload.documentId, collaborators);
    }, payload);
  }

  /** Un registro de Notification por colaborador, con actorType derivado de si tiene cuenta o fue invitado solo por email. */
  private async persistNotifications(
    documentId: string,
    collaborators: CollaboratorEntity[],
  ): Promise<void> {
    if (collaborators.length === 0) return;

    const rows = collaborators.map((collaborator) =>
      this.notificationRepository.create({
        collaboratorId: collaborator.id,
        documentId,
        isNotified: true,
        actorType: collaborator.userId
          ? ACTOR_TYPE_ENUM.ACCOUNT
          : ACTOR_TYPE_ENUM.WATCHER,
        notificationChannelSource: NOTIFICATION_CHANNEL_ENUM.EMAIL,
        delivered: true,
        sentAt: new Date(),
      }),
    );

    await this.notificationRepository.save(rows);
  }

  private async persistCreatorNotification(documentId: string): Promise<void> {
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

  /** Los errores al persistir Notification nunca deben tumbar el consumer — mismo criterio best-effort que EmailService en document.service.ts. */
  private async safely(
    fn: () => Promise<void>,
    payload: DocumentEventPayload,
  ): Promise<void> {
    try {
      await fn();
    } catch (error) {
      this.logger.error(
        `Error persistiendo notificaciones para el documento ${payload.documentId}: ${error}`,
      );
    }
  }

  private logEvent(action: string, payload: DocumentEventPayload) {
    this.logger.log(
      `Documento ${action}: ${payload.documentId} ("${payload.fileName}") por ${payload.actorUserId} @ ${payload.timestamp}`,
    );
  }
}
