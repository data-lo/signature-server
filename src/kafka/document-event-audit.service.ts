import { Injectable, Logger } from '@nestjs/common';

import { AuditChainService } from 'src/audit-chain/audit-chain.service';
import { AUDIT_TYPE_ENUM } from 'src/audit-chain/enums/audit-type.enum';

import { DocumentEventPayload } from './document-events.topics';

/**
 * Encadena en el ledger global de auditoría los eventos del ciclo de vida del documento (ver
 * `AuditChainService`, "Módulo de Auditoría e Integridad Global de BD").
 *
 * Best-effort a propósito: un fallo acá no debe tumbar el consumidor ni impedir que el resto
 * del procesamiento del evento —notificaciones, Document Transaction— continúe. Deja un hueco
 * en el ledger para ese evento puntual, y la cadena sigue siendo válida a partir del último
 * registro exitoso.
 */
@Injectable()
export class DocumentEventAuditService {
  private readonly logger = new Logger(DocumentEventAuditService.name);

  constructor(private readonly auditChainService: AuditChainService) {}

  async record(
    payload: DocumentEventPayload,
    auditType: AUDIT_TYPE_ENUM,
    extraMetadata?: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.auditChainService.recordEvent({
        documentId: payload.documentId,
        auditType,
        metadata: {
          fileName: payload.fileName,
          actorUserId: payload.actorUserId,
          ...extraMetadata,
        },
        timestamp: new Date(payload.timestamp),
      });
    } catch (error) {
      this.logger.error(
        `Error encadenando el ledger global de auditoría para el documento ${payload.documentId} (auditType=${auditType}): ${error}`,
      );
    }
  }
}
