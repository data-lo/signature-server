import { Injectable, Logger } from '@nestjs/common';

import { DocumentEventNotificationsService } from '../document-event-notifications.service';
import { DocumentEventPayload } from '../document-events.topics';

/**
 * `document.cancellation_requested`: el creador pidió cancelar.
 *
 * Se deja constancia sólo para los firmantes: son a quienes se les avisa, porque son los que ya
 * firmaron o tenían pendiente hacerlo. A diferencia de los otros eventos, éste no se encadena
 * en el ledger global — la cancelación se registra ahí cuando se consuma, no cuando se pide.
 */
@Injectable()
export class ProcessDocumentCancellationRequestedEventUseCase {
  private readonly logger = new Logger(
    ProcessDocumentCancellationRequestedEventUseCase.name,
  );

  constructor(
    private readonly notifications: DocumentEventNotificationsService,
  ) {}

  async execute(payload: DocumentEventPayload): Promise<void> {
    this.logger.log(
      `Documento cancelación solicitada: ${payload.documentId} ("${payload.fileName}") por ${payload.actorUserId} @ ${payload.timestamp}`,
    );

    try {
      const signers = await this.notifications.findSigners(payload.documentId);
      await this.notifications.persistForCollaborators(
        payload.documentId,
        signers,
      );
    } catch (error) {
      this.logger.error(
        `Error persistiendo notificaciones para el documento ${payload.documentId}: ${error}`,
      );
    }
  }
}
