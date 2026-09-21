import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { AuditService } from 'src/audit/audit.service';
import { AuditAction } from 'src/audit/schema/audit-document';
import { BaseResponse } from 'src/interfaces/api-response.dto';
import { DocumentEventsProducer } from 'src/kafka/document-events.producer';
import { DOCUMENT_KAFKA_TOPICS } from 'src/kafka/document-events.topics';

import { DocumentService } from '../document.service';
import { CollaboratorEntity } from '../entities/collaborator.entity';
import { DocumentEntity } from '../entities/document.entity';
import { COLLABORATOR_STATUS_ENUM } from '../enum/collaborator-status.enum';
import { DOCUMENT_STATUS_ENUM } from '../enum/document-status.enum';
import { DocumentApprovalService } from '../services/document-approval.service';

/**
 * `POST /api/v1/documents/:documentId/approval/reject`: el reviewer niega la autorización
 * (historia "Implementar flujo de aprobación previo al proceso de firma").
 *
 * El documento queda en `REJECTED` y **el flujo de firma no llega a empezar**: ningún firmante es
 * notificado ni puede firmar, porque nunca pasó por `PENDING_SIGNATURE`. Es la diferencia con
 * `RejectDocumentUseCase`, donde quien rechaza es un firmante y el documento ya estaba en firma;
 * por eso el evento que se publica también es otro (`document.approval_rejected`).
 */
@Injectable()
export class RejectDocumentApprovalUseCase {
  private readonly logger = new Logger(RejectDocumentApprovalUseCase.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly documentApprovalService: DocumentApprovalService,
    private readonly documentService: DocumentService,
    private readonly auditService: AuditService,
    private readonly documentEventsProducer: DocumentEventsProducer,
  ) {}

  /**
   * Registra el rechazo de la aprobación.
   *
   * @param documentId - Documento sobre el que se decide.
   * @param currentUserId - Usuario autenticado, que debe ser el reviewer asignado.
   * @param resolutionNote - Comentario opcional con el motivo; se guarda tal cual en el
   *   colaborador y viaja en el evento para quien tenga que explicárselo al creador.
   * @returns Confirmación con el estado al que quedó el documento.
   *
   * @throws {NotFoundException} (404) Si el documento no existe o no tiene reviewer asignado.
   * @throws {BadRequestException} (400) Si el documento no requiere aprobación, no está en
   *   `PENDING_APPROVAL`, o su reviewer ya resolvió.
   * @throws {ForbiddenException} (403) Si quien llama no es el reviewer asignado.
   *
   * @example
   * ```ts
   * await rejectDocumentApproval.execute('doc-1', 'user-reviewer', 'Falta el anexo B');
   * // { data: { status: 'REJECTED' } }
   * ```
   */
  async execute(
    documentId: string,
    currentUserId: string,
    resolutionNote?: string,
  ): Promise<BaseResponse<{ status: DOCUMENT_STATUS_ENUM }>> {
    const { document, reviewer } =
      await this.documentApprovalService.loadDecidable(
        documentId,
        currentUserId,
      );

    const resolvedAt = new Date();

    // Una sola transacción, por lo mismo que al aprobar: un documento rechazado cuyo reviewer
    // siguiera en PENDING invitaría a reintentar una decisión que ya se tomó.
    await this.dataSource.transaction(async (manager) => {
      const claim = await manager.getRepository(CollaboratorEntity).update(
        { id: reviewer.id, status: COLLABORATOR_STATUS_ENUM.PENDING },
        {
          status: COLLABORATOR_STATUS_ENUM.REJECTED,
          resolvedAt,
          resolutionNote: resolutionNote ?? null,
        },
      );
      if (claim.affected !== 1) {
        throw new Error('Ya registraste una decisión sobre este documento');
      }

      await manager.getRepository(DocumentEntity).update(
        { id: documentId, status: DOCUMENT_STATUS_ENUM.PENDING_APPROVAL },
        {
          status: DOCUMENT_STATUS_ENUM.REJECTED,
          rejectedAt: resolvedAt,
        },
      );

      // Dentro de la transacción, por lo mismo que al aprobar (ver `OutboxService`).
      await this.documentEventsProducer.enqueueApprovalEvent(
        manager,
        DOCUMENT_KAFKA_TOPICS.APPROVAL_REJECTED,
        {
          documentId,
          fileName: document.fileName,
          actorUserId: currentUserId,
          collaboratorId: reviewer.id,
          resolutionNote: resolutionNote ?? null,
        },
      );
    });

    void this.auditService.create({
      documentId,
      operation: AuditAction.DOCUMENT_APPROVAL_REJECTED,
      ipAddress: document.ipAddress ?? '0.0.0.0',
      users: [
        {
          userId: currentUserId,
          action: AuditAction.DOCUMENT_APPROVAL_REJECTED,
        },
      ],
    });

    await this.documentEventsProducer.flushOutbox();

    /**
     * Sólo se avisa al creador. A los firmantes no se les dice nada porque nunca supieron que
     * este documento existía: con aprobación pendiente no se les notificó, así que un correo de
     * rechazo sería la primera noticia que tendrían de él.
     */
    try {
      await this.documentService.notifyCreatorOfApprovalRejection(
        documentId,
        resolutionNote ?? null,
      );
    } catch (error) {
      this.logger.error(
        `Error avisando al creador del rechazo de aprobación del documento ${documentId}: ${error}`,
      );
    }

    return {
      success: true,
      message: 'Documento rechazado correctamente',
      data: { status: DOCUMENT_STATUS_ENUM.REJECTED },
    };
  }
}
