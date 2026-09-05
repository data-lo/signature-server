import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { CollaboratorEntity } from 'src/document/entities/collaborator.entity';
import { DocumentEntity } from 'src/document/entities/document.entity';
import { UserEntity } from 'src/user/entities/user.entity';
import { COLABORATOR_TYPE_ENUM } from 'src/document/enum/colaborator-type.enum';
import { SIGNEE_STATUS_ENUM } from 'src/document/enum/signee-status.enum';
import { SIGNATURE_TYPE_ENUM } from 'src/document/enum/signature-type.enum';

import { EmailService } from 'src/shared/email/email.service';

// Utilities
import {
  collaboratorDisplayName,
  collaboratorEmail,
} from 'src/document/utils/collaborator-display.util';
import {
  buildAllDocumentsUrl,
  buildDocumentAccessUrl,
} from 'src/document/utils/document-access-url.util';
import { getNextPendingSigner } from 'src/document/utils/next-signer.util';

import { NotificationEventPayload } from '../notification-events.topics';

/**
 * Manda el correo de "tienes un documento por firmar" al colaborador de la notificación, si es que
 * le toca (`notification.created`).
 *
 * Todas las condiciones de abajo son razones para NO mandar nada, y ninguna es un error: la
 * notificación se persiste para cualquier colaborador, y acá se decide a quién le corresponde además
 * un correo.
 *
 *  - Sólo firmantes pendientes: a un observador no se le pide firmar, y a quien ya respondió tampoco.
 *  - En un documento no secuencial de firma simple no se manda nada: todos pueden firmar cuando
 *    quieran y el aviso sale por otra vía.
 *  - En uno secuencial, sólo a quien está en turno: avisar a los demás los mandaría a una pantalla
 *    donde todavía no pueden hacer nada.
 */
@Injectable()
export class SendPendingSignatureNotificationUseCase {
  private readonly logger = new Logger(
    SendPendingSignatureNotificationUseCase.name,
  );

  constructor(
    @InjectRepository(CollaboratorEntity)
    private readonly collaboratorRepository: Repository<CollaboratorEntity>,
    @InjectRepository(DocumentEntity)
    private readonly documentRepository: Repository<DocumentEntity>,
    @InjectRepository(UserEntity)
    private readonly userRepository: Repository<UserEntity>,
    private readonly emailService: EmailService,
  ) {}

  async execute(payload: NotificationEventPayload): Promise<void> {
    this.logger.log(
      `Notification creada: ${payload.notificationId} (documento ${payload.documentId}, colaborador ${payload.collaboratorId})`,
    );

    try {
      await this.sendIfApplies(payload);
    } catch (error: any) {
      this.logger.error(
        `Error enviando el correo de notificación para el colaborador ${payload.collaboratorId} del documento ${payload.documentId}: ${error?.message || error}`,
        error?.stack,
      );
    }
  }

  private async sendIfApplies(
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

    await this.emailService.sendDocumentPendingNotification(
      recipientEmail,
      collaboratorDisplayName(collaborator),
      creator.email,
      document.fileName,
      buildDocumentAccessUrl(document.id, collaborator.id, recipientEmail),
      buildAllDocumentsUrl(),
    );

    this.logger.log(
      `Correo de notificación pendiente enviado a ${recipientEmail} (documento ${document.id}, colaborador ${collaborator.id})`,
    );
  }
}
