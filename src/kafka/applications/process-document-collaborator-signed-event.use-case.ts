import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { AUDIT_TYPE_ENUM } from 'src/audit-chain/enums/audit-type.enum';
import { CollaboratorEntity } from 'src/document/entities/collaborator.entity';
import { DocumentEntity } from 'src/document/entities/document.entity';
import { SIGNATURE_TYPE_ENUM } from 'src/document/enum/signature-type.enum';
import { SIGNEE_STATUS_ENUM } from 'src/document/enum/signee-status.enum';
import { DocumentTransactionService } from 'src/document/document-transaction.service';

import { DocumentEventAuditService } from '../document-event-audit.service';
import { DocumentEventNotificationsService } from '../document-event-notifications.service';
import { DocumentCollaboratorSignedPayload } from '../document-events.topics';

/**
 * `document.collaborator_signed`: se dispara por CADA firmante, y es el único punto donde se
 * decide qué entra a la cadena de `DocumentTransaction` según el tipo de firma:
 *
 *  - **Firma simple** → un registro encadenado por cada firma.
 *  - **Firma avanzada (FIEL)** → ningún registro por firmante; su evidencia criptográfica ya
 *    vive en `CollaboratorEntity.advancedSignature` (ver `EfirmaService`).
 *  - Cuando esta firma es la que completa el documento y hay al menos una firma avanzada, se
 *    agrega el registro final del documento.
 *
 * El registro final se resuelve acá y no al consumir `document.signed` a propósito: son tópicos
 * distintos —y `document.signed` se emite además ANTES que éste—, así que Kafka no garantiza en
 * qué orden se consumen y la cadena podía cerrarse antes de encadenar la última firma simple.
 * Acá ambas cosas ocurren en secuencia dentro del mismo caso de uso.
 */
@Injectable()
export class ProcessDocumentCollaboratorSignedEventUseCase {
  private readonly logger = new Logger(
    ProcessDocumentCollaboratorSignedEventUseCase.name,
  );

  constructor(
    @InjectRepository(DocumentEntity)
    private readonly documentRepository: Repository<DocumentEntity>,
    private readonly notifications: DocumentEventNotificationsService,
    private readonly documentTransactionService: DocumentTransactionService,
    private readonly audit: DocumentEventAuditService,
  ) {}

  async execute(payload: DocumentCollaboratorSignedPayload): Promise<void> {
    this.logger.log(
      `Documento firmado por el colaborador ${payload.collaboratorId}: ${payload.documentId} ("${payload.fileName}") por ${payload.actorUserId} @ ${payload.timestamp}`,
    );

    try {
      const signers = await this.notifications.findSigners(payload.documentId);
      const signer = signers.find((s) => s.id === payload.collaboratorId);

      if (signer?.signatureType === SIGNATURE_TYPE_ENUM.SIMPLE) {
        await this.documentTransactionService.registerSignature(
          payload.documentId,
          payload.collaboratorId,
          payload.signedAt,
        );
      }

      await this.registerCompletionIfDone(payload.documentId, signers);
    } catch (error) {
      this.logger.error(
        `Error encadenando Document Transaction para el documento ${payload.documentId} (colaborador ${payload.collaboratorId}): ${error}`,
      );
    }

    await this.audit.record(payload, AUDIT_TYPE_ENUM.SIGNATURES_PARTIAL, {
      collaboratorId: payload.collaboratorId,
    });
  }

  /**
   * Cierra la cadena del documento cuando ya no queda ningún firmante pendiente y el documento
   * incluye firma avanzada. En un documento de pura firma simple no se agrega nada: la última
   * firma ya dejó su propio registro y un registro final sería redundante.
   */
  private async registerCompletionIfDone(
    documentId: string,
    signers: CollaboratorEntity[],
  ): Promise<void> {
    const allSigned =
      signers.length > 0 &&
      signers.every((s) => s.status === SIGNEE_STATUS_ENUM.SIGNED);
    const hasAdvancedSignature = signers.some(
      (s) => s.signatureType === SIGNATURE_TYPE_ENUM.FIEL,
    );

    if (!allSigned || !hasAdvancedSignature) {
      return;
    }

    const document = await this.documentRepository.findOne({
      where: { id: documentId },
    });

    /**
     * El hash del PDF final ya estampado (la finalización corre antes de emitir el evento):
     * liga el último eslabón de la cadena al archivo que quedó como resultado.
     */
    await this.documentTransactionService.registerCompletion(
      documentId,
      document?.signedHash ?? '',
    );
  }
}
