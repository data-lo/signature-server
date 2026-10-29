import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';

import { EmailService } from 'src/common/email/email.service';
import { NotificationEventsProducer } from 'src/kafka/notification-events.producer';

import { CollaboratorEntity } from '../entities/collaborator.entity';
import { NotificationEntity } from '../entities/notification.entity';
import { COLABORATOR_TYPE_ENUM } from '../enum/colaborator-type.enum';
import { COLLABORATOR_STATUS_ENUM } from '../enum/collaborator-status.enum';
import { collaboratorDisplayName } from '../utils/collaborator-display.util';
import { sendToEachAddress } from '../utils/send-to-each-address.util';

/**
 * Avisos por correo a los testigos (`WITNESS`) en los momentos del ciclo de vida del documento
 * que no cubre otro flujo (historia "Corregir notificaciones por correo para testigos durante el
 * ciclo de vida del documento").
 *
 * Quién recibe qué, de punta a punta:
 *
 * | Momento | Correo al testigo | Quién lo manda |
 * |---|---|---|
 * | Documento enviado a firma (al crear, o al aprobarse si requería aprobación) | "Te agregaron como testigo" | `SendPendingSignatureNotificationUseCase`, vía `notification.created`; tras la aprobación lo re-publica `announcePendingWitnesses` |
 * | Un firmante rechaza | "Documento rechazado" (versión para testigo) | `notifyWitnessesOfRejection` |
 * | Todos firmaron | "Documento firmado", con el PDF final | `DocumentService.sendCompletionEmails` |
 * | Cancelación confirmada | "Documento cancelado" | `ConfirmDocumentCancellationUseCase` |
 *
 * Deliberadamente sin correo: cada firma individual (el testigo no tiene nada que hacer entre
 * firma y firma), la solicitud de cancelación (es una decisión que toman los firmantes) y la
 * aprobación negada (el documento nunca salió a firma, igual que para los firmantes).
 *
 * Todo es best-effort: un correo que falla se registra y no interrumpe ni al flujo que lo
 * disparó ni a los demás destinatarios.
 */
@Injectable()
export class WitnessNotificationService {
  private readonly logger = new Logger(WitnessNotificationService.name);

  constructor(
    @InjectRepository(CollaboratorEntity)
    private readonly collaboratorRepository: Repository<CollaboratorEntity>,
    @InjectRepository(NotificationEntity)
    private readonly notificationRepository: Repository<NotificationEntity>,
    private readonly notificationEventsProducer: NotificationEventsProducer,
    private readonly emailService: EmailService,
  ) {}

  /**
   * Vuelve a publicar `notification.created` para los testigos que todavía no recibieron el
   * correo de "te agregaron como testigo".
   *
   * Existe por el documento con aprobación: al crearlo, el consumidor descarta el aviso porque
   * el documento está en `PENDING_APPROVAL`, y hasta ahora nadie lo volvía a intentar cuando se
   * aprobaba, así que el testigo nunca se enteraba. Se reutiliza la notificación que ya se creó
   * con el documento en vez de mandar el correo desde aquí: así el envío, el paso a NOTIFIED y la
   * protección contra duplicados siguen viviendo en un solo lugar.
   *
   * Sólo toma testigos en PENDING: el que ya está NOTIFIED no vuelve a recibir nada, aunque esto
   * se llame dos veces.
   *
   * @param documentId - Documento que acaba de entrar a firma.
   * @param actorUserId - Quien provocó el cambio (el reviewer que aprobó), para la auditoría del evento.
   * @returns Cuántos avisos se publicaron.
   *
   * @example
   * ```ts
   * await this.witnessNotificationService.announcePendingWitnesses('doc-1', 'user-reviewer');
   * ```
   */
  async announcePendingWitnesses(
    documentId: string,
    actorUserId: string,
  ): Promise<number> {
    const witnesses = await this.collaboratorRepository.find({
      where: {
        documentId,
        colaboratorType: COLABORATOR_TYPE_ENUM.WITNESS,
        status: COLLABORATOR_STATUS_ENUM.PENDING,
      },
    });
    if (witnesses.length === 0) return 0;

    const notifications = await this.notificationRepository.find({
      where: {
        documentId,
        collaboratorId: In(witnesses.map((witness) => witness.id)),
      },
    });

    let announced = 0;
    for (const witness of witnesses) {
      const notification = notifications.find(
        (candidate) => candidate.collaboratorId === witness.id,
      );
      if (!notification) {
        this.logger.warn(
          `El testigo ${witness.id} del documento ${documentId} no tiene notificación que publicar`,
        );
        continue;
      }

      this.notificationEventsProducer.emitCreated({
        notificationId: notification.id,
        documentId,
        collaboratorId: witness.id,
        actorType: notification.actorType,
        notificationChannelSource: notification.notificationChannelSource,
        actorUserId,
      });
      announced += 1;
    }

    return announced;
  }

  /**
   * Avisa a los testigos de que un firmante rechazó el documento.
   *
   * El creador ya recibe su propio correo de rechazo (redactado para quien envió el documento);
   * éste es la versión para quien sólo lo sigue. Un correo por dirección, aunque el mismo correo
   * aparezca en dos testigos.
   *
   * @param params.documentId - Documento rechazado.
   * @param params.documentName - Nombre del documento, para el correo.
   * @param params.rejecterName - Quién lo rechazó.
   * @param params.reason - Motivo que dio.
   * @returns Nada.
   *
   * @throws Nada: los fallos de correo se registran y no se propagan.
   *
   * @example
   * ```ts
   * await this.witnessNotificationService.notifyWitnessesOfRejection({
   *   documentId: 'doc-1',
   *   documentName: 'contrato.pdf',
   *   rejecterName: 'Juan Pérez',
   *   reason: 'Faltan las cláusulas',
   * });
   * ```
   */
  async notifyWitnessesOfRejection(params: {
    documentId: string;
    documentName: string;
    rejecterName: string;
    reason: string;
  }): Promise<void> {
    const { documentId, documentName, rejecterName, reason } = params;

    const witnesses = await this.collaboratorRepository.find({
      where: { documentId, colaboratorType: COLABORATOR_TYPE_ENUM.WITNESS },
      relations: { account: { user: true } },
    });

    await sendToEachAddress(
      witnesses,
      (witness, to) =>
        this.emailService.sendDocumentRejectedToWitnessNotification(
          to,
          collaboratorDisplayName(witness),
          rejecterName,
          documentName,
          reason,
        ),
      (to, error) =>
        this.logger.error(
          `Error notificando el rechazo del documento ${documentId} al testigo ${to}: ${error}`,
        ),
    );
  }
}
