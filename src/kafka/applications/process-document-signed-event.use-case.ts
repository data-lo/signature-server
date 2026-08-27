import { Injectable, Logger } from '@nestjs/common';

import { AUDIT_TYPE_ENUM } from 'src/audit-chain/enums/audit-type.enum';

import { DocumentEventAuditService } from '../document-event-audit.service';
import { DocumentEventNotificationsService } from '../document-event-notifications.service';
import { DocumentEventPayload } from '../document-events.topics';

/**
 * `document.signed`: el documento quedó firmado por todos.
 *
 * Se deja constancia para **todos** los colaboradores, no sólo los firmantes: el aviso de
 * documento completado sale a observadores y revisores por igual.
 */
@Injectable()
export class ProcessDocumentSignedEventUseCase {
  private readonly logger = new Logger(ProcessDocumentSignedEventUseCase.name);

  constructor(
    private readonly notifications: DocumentEventNotificationsService,
    private readonly audit: DocumentEventAuditService,
  ) {}

  async execute(payload: DocumentEventPayload): Promise<void> {
    this.logger.log(
      `Documento firmado: ${payload.documentId} ("${payload.fileName}") por ${payload.actorUserId} @ ${payload.timestamp}`,
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

    await this.audit.record(payload, AUDIT_TYPE_ENUM.SIGNATURES_COMPLETED);
  }
}
