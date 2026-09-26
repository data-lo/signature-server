// Framework & third-party libraries
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

// Entities & Enums
import { CollaboratorEntity } from 'src/document/entities/collaborator.entity';
import { DocumentEntity } from 'src/document/entities/document.entity';
import { NotificationEntity } from 'src/document/entities/notification.entity';
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
 * correo...") — ver `sendWitnessNotification`. REVIEWER: manda "tienes un documento pendiente de
 * aprobación" mientras el documento sigue en `PENDING_APPROVAL` (historia "Corregir notificación
 * por correo a aprobadores asignados") — ver `sendReviewerNotification`. Cualquier otro tipo no
 * recibe nada.
 *
 * La guarda de `status !== PENDING` es compartida: para SIGNER evita reavisar a quien ya
 * respondió, para REVIEWER a quien ya aprobó o rechazó, y para WITNESS es además la condición de
 * "no reprocesar" — un WITNESS que ya está NOTIFIED nunca vuelve a pasar por aquí, ni si Kafka
 * reentrega el mismo evento.
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
    @InjectRepository(NotificationEntity)
    private readonly notificationRepository: Repository<NotificationEntity>,
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

    if (collaborator.colaboratorType === COLABORATOR_TYPE_ENUM.REVIEWER) {
      await this.sendReviewerNotification(collaborator, document, payload);
      return;
    }

    // Cualquier tipo futuro: sin correo hasta que se defina cuál le corresponde.
  }

  /**
   * Avisa al aprobador asignado que tiene un documento pendiente de aprobación.
   *
   * Sólo mientras el documento sigue en `PENDING_APPROVAL`: si ya salió de ese estado (aprobado,
   * rechazado, cancelado) entre la publicación del evento y su consumo, el aviso ya no pide nada
   * que se pueda hacer.
   *
   * **La deduplicación va sobre la fila de `notifications` de ESTA asignación, no sobre el
   * estatus del colaborador.** Al testigo se le marca NOTIFIED, pero el aprobador tiene que seguir
   * en PENDING: es lo que `DocumentApprovalService` exige para aprobar o rechazar. Cada asignación
   * crea su propia notificación, así que el claim `isNotified: false → true` —condicionado, antes
   * de enviar— deja pasar un solo correo por asignación aunque Kafka reentregue el evento, y un
   * aprobador asignado después, con su propia notificación, recibe el suyo.
   *
   * Si el envío falla se revierte el claim —también condicionado— y el error sube a `execute()`,
   * que lo registra sin propagarlo: la creación del documento ya confirmó y no se ve afectada, y
   * la notificación queda lista para la siguiente entrega del evento.
   *
   * @param collaborator - Colaborador REVIEWER, con `account.user` cargado para nombre y correo.
   * @param document - Documento al que se le asignó, ya leído por `sendIfApplies`; null si no existe.
   * @param payload - Evento `notification.created`; su `notificationId` es la llave del claim.
   * @returns Nada; si no corresponde enviar, sólo lo registra en el log.
   *
   * @throws {InternalServerErrorException} Si SendGrid rechaza el envío (desde `EmailService`),
   *   después de revertir el claim.
   *
   * @example
   * ```ts
   * await this.sendReviewerNotification(reviewer, document, payload);
   * ```
   */
  private async sendReviewerNotification(
    collaborator: CollaboratorEntity,
    document: DocumentEntity | null,
    payload: NotificationEventPayload,
  ): Promise<void> {
    if (!document) {
      this.logger.warn(
        `Documento ${payload.documentId} no encontrado al notificar al aprobador ${collaborator.id}`,
      );
      return;
    }

    if (document.status !== DOCUMENT_STATUS_ENUM.PENDING_APPROVAL) {
      this.logger.log(
        `El documento ${document.id} ya no espera aprobación (${document.status}): no se avisa al aprobador ${collaborator.id}`,
      );
      return;
    }

    const creator = await this.userRepository.findOne({
      where: { id: document.createdBy },
    });
    if (!creator) {
      this.logger.warn(
        `Usuario creador ${document.createdBy} no encontrado al notificar al aprobador ${collaborator.id} del documento ${document.id}`,
      );
      return;
    }

    const recipientEmail = collaboratorEmail(collaborator);
    if (!recipientEmail) {
      this.logger.warn(
        `No se pudo determinar el email para el aprobador ${collaborator.id}`,
      );
      return;
    }

    const claim = await this.notificationRepository.update(
      { id: payload.notificationId, isNotified: false },
      { isNotified: true, sentAt: new Date() },
    );
    if (claim.affected !== 1) {
      this.logger.warn(
        `La notificación ${payload.notificationId} ya estaba enviada: no se repite el correo al aprobador ${collaborator.id} (documento ${document.id})`,
      );
      return;
    }

    try {
      await this.emailService.sendDocumentApprovalRequestedNotification(
        recipientEmail,
        collaboratorDisplayName(collaborator),
        document.fileName,
        `${creator.firstName ?? ''} ${creator.lastName ?? ''}`.trim() ||
          creator.email,
        creator.email,
        buildDocumentAccessUrl(document.id, collaborator.id, recipientEmail),
      );
    } catch (error) {
      await this.notificationRepository.update(
        { id: payload.notificationId, isNotified: true },
        { isNotified: false, sentAt: null },
      );
      throw error;
    }

    await this.notificationRepository.update(
      { id: payload.notificationId },
      { delivered: true },
    );

    this.logger.log(
      `Correo de aprobación pendiente enviado a ${recipientEmail} (documento ${document.id}, colaborador ${collaborator.id})`,
    );
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
   * El claim `PENDING → NOTIFIED` se hace ANTES de enviar, condicionado a `status: PENDING` —mismo
   * patrón que `reject-document.use-case.ts` usa para el rechazo—, y sólo quien lo gana manda el
   * correo. Antes se enviaba primero y se marcaba después: dos entregas simultáneas del mismo
   * evento (Kafka reentregando, o el re-aviso tras la aprobación coincidiendo con el original)
   * pasaban las dos la guarda de PENDING y el testigo recibía el correo dos veces (historia
   * "Corregir notificaciones por correo para testigos").
   *
   * Si el envío falla, el estatus vuelve a PENDING —también condicionado, para no pisar a nadie—
   * y el error sube a `execute()`, que lo registra. El testigo queda listo para reintentarse con
   * la siguiente entrega del evento, igual que antes.
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

    const claim = await this.collaboratorRepository.update(
      { id: collaborator.id, status: COLLABORATOR_STATUS_ENUM.PENDING },
      { status: COLLABORATOR_STATUS_ENUM.NOTIFIED },
    );
    if (claim.affected !== 1) {
      this.logger.warn(
        `El testigo ${collaborator.id} ya no estaba PENDING: otra entrega del evento ya lo notificó (documento ${document.id})`,
      );
      return;
    }

    try {
      await this.emailService.sendDocumentWitnessAddedNotification(
        recipientEmail,
        collaboratorDisplayName(collaborator),
        document.fileName,
        `${creator.firstName ?? ''} ${creator.lastName ?? ''}`.trim() ||
          creator.email,
        creator.email,
        buildDocumentAccessUrl(document.id, collaborator.id, recipientEmail),
      );
    } catch (error) {
      await this.collaboratorRepository.update(
        { id: collaborator.id, status: COLLABORATOR_STATUS_ENUM.NOTIFIED },
        { status: COLLABORATOR_STATUS_ENUM.PENDING },
      );
      throw error;
    }

    this.logger.log(
      `Correo de testigo enviado a ${recipientEmail} (documento ${document.id}, colaborador ${collaborator.id})`,
    );
  }
}
