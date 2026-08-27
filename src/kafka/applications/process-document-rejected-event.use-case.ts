import { Injectable, Logger } from '@nestjs/common';

import { AUDIT_TYPE_ENUM } from 'src/audit-chain/enums/audit-type.enum';

import { DocumentEventAuditService } from '../document-event-audit.service';
import { DocumentEventNotificationsService } from '../document-event-notifications.service';
import { DocumentEventPayload } from '../document-events.topics';

/**
 * `document.rejected`: alguien se negó a firmar.
 *
 * La constancia es sólo para el creador, porque el aviso de rechazo sólo se le manda a él: es
 * quien tiene que decidir qué hacer con el documento. Se guarda sin `collaboratorId` porque el
 * creador no siempre tiene fila de colaborador.
 */
@Injectable()
export class ProcessDocumentRejectedEventUseCase {
  private readonly logger = new Logger(
    ProcessDocumentRejectedEventUseCase.name,
  );

  constructor(
    private readonly notifications: DocumentEventNotificationsService,
    private readonly audit: DocumentEventAuditService,
  ) {}

  async execute(payload: DocumentEventPayload): Promise<void> {
    this.logger.log(
      `Documento rechazado: ${payload.documentId} ("${payload.fileName}") por ${payload.actorUserId} @ ${payload.timestamp}`,
    );

    try {
      await this.notifications.persistForCreator(payload.documentId);
    } catch (error) {
      this.logger.error(
        `Error persistiendo notificaciones para el documento ${payload.documentId}: ${error}`,
      );
    }

    await this.audit.record(payload, AUDIT_TYPE_ENUM.REJECTED);
  }
}
