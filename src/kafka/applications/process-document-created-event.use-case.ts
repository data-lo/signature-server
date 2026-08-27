import { Injectable, Logger } from '@nestjs/common';

import { AUDIT_TYPE_ENUM } from 'src/audit-chain/enums/audit-type.enum';

import { DocumentEventAuditService } from '../document-event-audit.service';
import { DocumentEventPayload } from '../document-events.topics';

/**
 * `document.created`: sólo encadena el evento en el ledger de auditoría.
 *
 * No persiste ninguna constancia de notificación porque en el alta no se manda ningún correo:
 * el documento nace en CREATED y nadie tiene todavía nada que firmar.
 */
@Injectable()
export class ProcessDocumentCreatedEventUseCase {
  private readonly logger = new Logger(ProcessDocumentCreatedEventUseCase.name);

  constructor(private readonly audit: DocumentEventAuditService) {}

  async execute(payload: DocumentEventPayload): Promise<void> {
    this.logger.log(
      `Documento creado: ${payload.documentId} ("${payload.fileName}") por ${payload.actorUserId} @ ${payload.timestamp}`,
    );

    await this.audit.record(payload, AUDIT_TYPE_ENUM.CREATED);
  }
}
