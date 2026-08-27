import { Injectable, Logger } from '@nestjs/common';

import { AUDIT_TYPE_ENUM } from 'src/audit-chain/enums/audit-type.enum';
import { getNextPendingSigner } from 'src/document/utils/next-signer.util';

import { DocumentEventAuditService } from '../document-event-audit.service';
import { DocumentEventNotificationsService } from '../document-event-notifications.service';
import { DocumentEventPayload } from '../document-events.topics';

/**
 * `document.sent_to_sign`: deja constancia de que se le pidió firmar al primero en turno y
 * encadena el evento.
 *
 * Sólo se registra ese firmante, no todos: el correo de solicitud sale uno a uno conforme le
 * toca a cada quien, así que anotar a los demás diría que se les avisó algo que todavía no
 * ocurrió.
 */
@Injectable()
export class ProcessDocumentSentToSignEventUseCase {
  private readonly logger = new Logger(
    ProcessDocumentSentToSignEventUseCase.name,
  );

  constructor(
    private readonly notifications: DocumentEventNotificationsService,
    private readonly audit: DocumentEventAuditService,
  ) {}

  async execute(payload: DocumentEventPayload): Promise<void> {
    this.logger.log(
      `Documento enviado a firma: ${payload.documentId} ("${payload.fileName}") por ${payload.actorUserId} @ ${payload.timestamp}`,
    );

    /**
     * Best-effort, mismo criterio que el resto del consumidor: un fallo al persistir la
     * constancia no debe impedir que el evento quede encadenado ni tumbar el consumidor.
     */
    try {
      const signers = await this.notifications.findSigners(payload.documentId);
      const nextSigner = getNextPendingSigner(signers);

      if (nextSigner) {
        await this.notifications.persistForCollaborators(payload.documentId, [
          nextSigner,
        ]);
      }
    } catch (error) {
      this.logger.error(
        `Error persistiendo notificaciones para el documento ${payload.documentId}: ${error}`,
      );
    }

    await this.audit.record(payload, AUDIT_TYPE_ENUM.PENDING);
  }
}
