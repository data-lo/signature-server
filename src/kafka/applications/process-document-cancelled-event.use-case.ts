import { Injectable, Logger } from '@nestjs/common';

import { DocumentEventNotificationsService } from '../document-event-notifications.service';
import { DocumentEventPayload } from '../document-events.topics';

/**
 * `document.cancelled`: la cancelación se consumó.
 *
 * La constancia va para todos los colaboradores —no sólo los firmantes—: el documento cancelado
 * deja de estar vigente para cualquiera que lo tuviera a la vista.
 */
@Injectable()
export class ProcessDocumentCancelledEventUseCase {
  private readonly logger = new Logger(
    ProcessDocumentCancelledEventUseCase.name,
  );

  constructor(
    private readonly notifications: DocumentEventNotificationsService,
  ) {}

  async execute(payload: DocumentEventPayload): Promise<void> {
    this.logger.log(
      `Documento cancelado: ${payload.documentId} ("${payload.fileName}") por ${payload.actorUserId} @ ${payload.timestamp}`,
    );

    try {
      const collaborators = await this.notifications.findCollaborators(
        payload.documentId,
      );
      await this.notifications.persistForCollaborators(
        payload.documentId,
        collaborators,
      );
    } catch (error) {
      this.logger.error(
        `Error persistiendo notificaciones para el documento ${payload.documentId}: ${error}`,
      );
    }
  }
}
