import { Controller, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { EventPattern, Payload } from '@nestjs/microservices';
import {
  NOTIFICATION_KAFKA_TOPICS,
  NotificationEventPayload,
} from './notification-events.topics';
import { CollaboratorEntity } from 'src/document/entities/collaborator.entity';
import { DocumentEntity } from 'src/document/entities/document.entity';
import { UserEntity } from 'src/user/entities/user.entity';
import { COLABORATOR_TYPE_ENUM } from 'src/document/enum/colaborator-type.enum';
import { SIGNEE_STATUS_ENUM } from 'src/document/enum/signee-status.enum';
import { SIGNATURE_TYPE_ENUM } from 'src/document/enum/signature-type.enum';
import { getNextPendingSigner } from 'src/document/utils/next-signer.util';
import {
  collaboratorDisplayName,
  collaboratorEmail,
} from 'src/document/utils/collaborator-display.util';
import { EmailService } from 'src/shared/email/email.service';

/**
 * Consumidor real de `notification.created` (ver NotificationEventsProducer — hasta ahora el
 * tópico se publicaba y se persistía en Postgres para trazabilidad, pero ningún worker lo
 * consumía para disparar el envío real del correo: por eso los colaboradores nunca recibían
 * notificación al crear un documento vía POST /api/v1/documents/signatures, aunque el documento
 * sí quedaba creado correctamente — ver bug "La notificación por correo electrónico no se envía
 * al crear un documento").
 *
 * Solo notifica a firmantes (WATCHER no tiene plantilla de correo todavía, mismo criterio que
 * `notifyNextSigner` en document.service.ts) que sigan PENDING, y respeta el mismo criterio de
 * turno que el resto del dominio:
 *  - Documento secuencial (isSequential=true, default): solo el siguiente firmante pendiente
 *    (los demás se notifican más adelante, cuando les toque — ver sign()/notifyNextSigner()).
 *  - Documento sin orden (isSequential=false): todos los firmantes pendientes, ya — salvo los
 *    que ya recibieron el correo dedicado de invitación de Firma Simple sin orden (ver
 *    DocumentSignaturesService.create()), para no duplicar el correo.
 */
@Controller()
export class NotificationEventsConsumer {
  private readonly logger = new Logger(NotificationEventsConsumer.name);

  constructor(
    @InjectRepository(CollaboratorEntity)
    private readonly collaboratorRepository: Repository<CollaboratorEntity>,
    @InjectRepository(DocumentEntity)
    private readonly documentRepository: Repository<DocumentEntity>,
    @InjectRepository(UserEntity)
    private readonly userRepository: Repository<UserEntity>,
    private readonly emailService: EmailService,
  ) { }

  @EventPattern(NOTIFICATION_KAFKA_TOPICS.CREATED)
  async handleCreated(@Payload() payload: NotificationEventPayload) {
    this.logger.log(
      `Notification creada: ${payload.notificationId} (documento ${payload.documentId}, colaborador ${payload.collaboratorId})`,
    );

    try {
      await this.sendPendingSignatureEmailIfApplies(payload);
    } catch (error: any) {
      this.logger.error(
        `Error enviando el correo de notificación para el colaborador ${payload.collaboratorId} del documento ${payload.documentId}: ${error?.message || error}`,
        error?.stack,
      );
    }
  }

  private async sendPendingSignatureEmailIfApplies(
    payload: NotificationEventPayload,
  ): Promise<void> {
    const collaborator = await this.collaboratorRepository.findOne({
      where: { id: payload.collaboratorId },
      relations: { account: { user: true } },
    });
    if (
      !collaborator ||
      collaborator.colaboratorType !== COLABORATOR_TYPE_ENUM.SIGNER ||
      collaborator.status !== SIGNEE_STATUS_ENUM.PENDING
    ) {
      return;
    }

    const document = await this.documentRepository.findOne({
      where: { id: payload.documentId },
    });
    if (!document) {
      this.logger.warn(
        `Documento ${payload.documentId} no encontrado al procesar la notificación ${payload.notificationId}`,
      );
      return;
    }

    // Ya recibió el correo dedicado de invitación (ver DocumentSignaturesService.create()) —
    // enviar también este lo duplicaría para la misma acción.
    if (
      !document.isSequential &&
      collaborator.signatureType === SIGNATURE_TYPE_ENUM.SIMPLE
    ) {
      return;
    }

    if (document.isSequential) {
      const signers = await this.collaboratorRepository.find({
        where: {
          documentId: payload.documentId,
          colaboratorType: COLABORATOR_TYPE_ENUM.SIGNER,
        },
      });
      const nextSigner = getNextPendingSigner(signers);
      if (nextSigner?.id !== collaborator.id) {
        return;
      }
    }

    const creator = await this.userRepository.findOne({
      where: { id: document.createdBy },
    });
    if (!creator) {
      this.logger.warn(
        `Usuario creador ${document.createdBy} no encontrado al notificar al colaborador ${collaborator.id} del documento ${document.id}`,
      );
      return;
    }
    const frontendUrl = process.env.FRONTEND_URL ?? 'http://frontend:3000';

    const recipientEmail = collaboratorEmail(collaborator);
    const recipientName = collaboratorDisplayName(collaborator);

    this.logger.debug({
      to: recipientEmail,
      name: recipientName,
      creatorEmail: creator.email,
      fileName: document.fileName,
    });

    if (!recipientEmail) {
      this.logger.warn(`No se pudo determinar el email para el colaborador ${collaborator.id}`);
      return;
    }

    await this.emailService.sendDocumentPendingNotification(
      recipientEmail,
      recipientName,
      creator.email,
      document.fileName,
      `${frontendUrl}/documents/${document.id}`,
      `${frontendUrl}/documents`,
    );

    this.logger.log(
      `Correo de notificación pendiente enviado a ${collaboratorEmail(collaborator)} (documento ${document.id}, colaborador ${collaborator.id})`,
    );
  }
}
