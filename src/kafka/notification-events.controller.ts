// Framework & third-party libraries
import { Controller, Logger } from '@nestjs/common';
import { EventPattern, Payload } from '@nestjs/microservices';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

// Entities & Enums
import { CollaboratorEntity } from 'src/document/entities/collaborator.entity';
import { DocumentEntity } from 'src/document/entities/document.entity';
import { UserEntity } from 'src/user/entities/user.entity';
import { COLABORATOR_TYPE_ENUM } from 'src/document/enum/colaborator-type.enum';
import { SIGNEE_STATUS_ENUM } from 'src/document/enum/signee-status.enum';
import { SIGNATURE_TYPE_ENUM } from 'src/document/enum/signature-type.enum';

// Services & Topics
import { EmailService } from 'src/shared/email/email.service';
import {
  NOTIFICATION_KAFKA_TOPICS,
  NotificationEventPayload,
} from './notification-events.topics';

// Utilities
import {
  collaboratorDisplayName,
  collaboratorEmail,
} from 'src/document/utils/collaborator-display.util';
import { getNextPendingSigner } from 'src/document/utils/next-signer.util';

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

    const recipientEmail = collaboratorEmail(collaborator);
    if (!recipientEmail) {
      this.logger.warn(
        `No se pudo determinar el email para el colaborador ${collaborator.id}`,
      );
      return;
    }

    const recipientName = collaboratorDisplayName(collaborator);
    const frontendUrl = process.env.FRONTEND_URL ?? 'http://frontend:3000';

    await this.emailService.sendDocumentPendingNotification(
      recipientEmail,
      recipientName,
      creator.email,
      document.fileName,
      `${frontendUrl}/documents/${document.id}`,
      `${frontendUrl}/documents`,
    );

    this.logger.log(
      `Correo de notificación pendiente enviado a ${recipientEmail} (documento ${document.id}, colaborador ${collaborator.id})`,
    );
  }
}