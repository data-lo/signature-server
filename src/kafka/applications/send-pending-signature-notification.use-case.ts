// Framework & third-party libraries
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

// Entities & Enums
import { CollaboratorEntity } from 'src/document/entities/collaborator.entity';
import { DocumentEntity } from 'src/document/entities/document.entity';
import { UserEntity } from 'src/user/entities/user.entity';
import { COLABORATOR_TYPE_ENUM } from 'src/document/enum/colaborator-type.enum';
import { COLLABORATOR_STATUS_ENUM } from 'src/document/enum/collaborator-status.enum';
import { SIGNATURE_TYPE_ENUM } from 'src/document/enum/signature-type.enum';

// Services
import { EmailService } from 'src/common/email/email.service';

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
import { DOCUMENT_STATUS_ENUM } from 'src/document/enum/document-status.enum';

/**
 * `notification.created`: procesa la notificación creada para un colaborador y decide qué correo
 * —si acaso alguno— le corresponde.
 *
 * SIGNER: manda "tienes un documento por firmar", condicionado al turno (ver
 * `sendSignerNotification`). WITNESS: manda "te agregaron como testigo" y, si el envío tiene
 * éxito, lo marca NOTIFIED (historia "Actualizar estatus de watchers a NOTIFIED tras el envío de
 * correo...") — ver `sendWitnessNotification`. Cualquier otro tipo (p. ej. REVIEWER) no recibe
 * nada todavía.
 *
 * La guarda de `status !== PENDING` es compartida: para SIGNER evita reavisar a quien ya
 * respondió, y para WITNESS es además la condición de "no reprocesar" — un WITNESS que ya está
 * NOTIFIED nunca vuelve a pasar por aquí, ni si Kafka reentrega el mismo evento.
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
      collaborator.status !== COLLABORATOR_STATUS_ENUM.PENDING
    ) {
      return;
    }

    /**
     * Mientras el documento espera aprobación no sale ningún correo de firma (historia
     * "Implementar flujo de aprobación previo al proceso de firma"). La guarda se pone aquí, en
     * el consumidor, y no en quien publica el evento: así la regla depende del estado REAL del
     * documento en el momento de enviar —incluido el caso en que la aprobación llegue entre la
     * publicación del evento y su consumo— y no de que cada productor se acuerde de filtrar.
     *
     * A los firmantes se les avisa cuando el reviewer aprueba, y de eso se encargan
     * `notifyNextSigner` y `sendSimpleSignatureInvitations`.
     */
    const document = await this.documentRepository.findOne({
      where: { id: payload.documentId },
    });
    if (
      document?.status === DOCUMENT_STATUS_ENUM.PENDING_APPROVAL &&
      collaborator.colaboratorType !== COLABORATOR_TYPE_ENUM.REVIEWER
    ) {
      return;
    }

    if (collaborator.colaboratorType === COLABORATOR_TYPE_ENUM.SIGNER) {
      await this.sendSignerNotification(collaborator, payload);
      return;
    }

    if (collaborator.colaboratorType === COLABORATOR_TYPE_ENUM.WITNESS) {
      await this.sendWitnessNotification(collaborator, payload);
      return;
    }

    // REVIEWER (y cualquier tipo futuro): sin correo por ahora, sin cambios de comportamiento.
  }

  private async sendSignerNotification(
    collaborator: CollaboratorEntity,
    payload: NotificationEventPayload,
  ): Promise<void> {
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

  /**
   * El estatus sólo se mueve a NOTIFIED DESPUÉS de que el correo salga bien: si `sendEmail` lanza,
   * el `try/catch` de `execute()` lo traga y el colaborador se queda en PENDING, listo para
   * reprocesarse si Kafka reentrega el evento.
   *
   * El update es un claim atómico condicionado a `status: PENDING` —mismo patrón que
   * `reject-document.use-case.ts` usa para el rechazo— y no una escritura plana: cierra la
   * ventana de carrera de una entrega duplicada del mismo evento intentando notificar dos veces.
   */
  private async sendWitnessNotification(
    collaborator: CollaboratorEntity,
    payload: NotificationEventPayload,
  ): Promise<void> {
    const document = await this.documentRepository.findOne({
      where: { id: payload.documentId },
    });
    if (!document) {
      this.logger.warn(
        `Documento ${payload.documentId} no encontrado al notificar al testigo ${collaborator.id}`,
      );
      return;
    }

    const creator = await this.userRepository.findOne({
      where: { id: document.createdBy },
    });
    if (!creator) {
      this.logger.warn(
        `Usuario creador ${document.createdBy} no encontrado al notificar al testigo ${collaborator.id} del documento ${document.id}`,
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

    await this.emailService.sendDocumentWitnessAddedNotification(
      recipientEmail,
      collaboratorDisplayName(collaborator),
      document.fileName,
      `${creator.firstName ?? ''} ${creator.lastName ?? ''}`.trim() ||
        creator.email,
      creator.email,
      buildDocumentAccessUrl(document.id, collaborator.id, recipientEmail),
    );

    const claim = await this.collaboratorRepository.update(
      { id: collaborator.id, status: COLLABORATOR_STATUS_ENUM.PENDING },
      { status: COLLABORATOR_STATUS_ENUM.NOTIFIED },
    );
    if (claim.affected !== 1) {
      this.logger.warn(
        `El colaborador ${collaborator.id} ya no estaba PENDING al intentar marcarlo NOTIFIED (posible entrega duplicada del evento)`,
      );
    }

    this.logger.log(
      `Correo de testigo enviado a ${recipientEmail} (documento ${document.id}, colaborador ${collaborator.id})`,
    );
  }
}
