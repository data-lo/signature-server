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
import { WitnessNotificationService } from '../services/witness-notification.service';

/**
 * `POST /api/v1/documents/:documentId/approval/approve`: el reviewer autoriza que el documento
 * salga a firma (historia "Implementar flujo de aprobación previo al proceso de firma").
 *
 * A partir de aquí el documento **se incorpora al flujo de firma que ya existe**, sin ninguna
 * variante propia: pasa a `PENDING_SIGNATURE` —el mismo estado en el que nace un documento que no
 * requiere aprobación— y se avisa a quien corresponda con los mismos mecanismos. Aprobar no es
 * una forma distinta de firmar; es quitar el freno.
 *
 * Es el gemelo de `SubmitDocumentForAuthorizationUseCase`, que hace lo mismo desde el borrador:
 * ambos dejan el documento en `PENDING_SIGNATURE`, publican `document.sent_to_sign` y llaman a
 * `notifyNextSigner`.
 */
@Injectable()
export class ApproveDocumentUseCase {
  private readonly logger = new Logger(ApproveDocumentUseCase.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly documentApprovalService: DocumentApprovalService,
    private readonly documentService: DocumentService,
    private readonly auditService: AuditService,
    private readonly documentEventsProducer: DocumentEventsProducer,
    private readonly witnessNotificationService: WitnessNotificationService,
  ) {}

  /**
   * Registra la aprobación y arranca el flujo de firma.
   *
   * @param documentId - Documento a aprobar.
   * @param currentUserId - Usuario autenticado, que debe ser el reviewer asignado.
   * @returns Confirmación con el estado al que quedó el documento.
   *
   * @throws {NotFoundException} (404) Si el documento no existe o no tiene reviewer asignado.
   * @throws {BadRequestException} (400) Si el documento no requiere aprobación, no está en
   *   `PENDING_APPROVAL`, o su reviewer ya resolvió.
   * @throws {ForbiddenException} (403) Si quien llama no es el reviewer asignado.
   *
   * @example
   * ```ts
   * await approveDocument.execute('doc-1', 'user-reviewer');
   * // { data: { status: 'PENDING_SIGNATURE' } }
   * ```
   */
  async execute(
    documentId: string,
    currentUserId: string,
  ): Promise<BaseResponse<{ status: DOCUMENT_STATUS_ENUM }>> {
    const { document, reviewer } =
      await this.documentApprovalService.loadDecidable(
        documentId,
        currentUserId,
      );

    const resolvedAt = new Date();

    /**
     * El reviewer y el documento se escriben en UNA transacción: un documento en
     * `PENDING_SIGNATURE` cuyo reviewer siguiera en `PENDING` sería un documento firmable que
     * nadie aprobó, y el reviewer en `APPROVED` con el documento sin mover dejaría un documento
     * que ya no puede aprobarse y que tampoco se puede firmar.
     */
    await this.dataSource.transaction(async (manager) => {
      /**
       * Se actualiza exigiendo que siga en PENDING, y se comprueba `affected`: dos peticiones
       * simultáneas del mismo reviewer —un doble clic— llegan las dos a pasar las validaciones,
       * y es esta condición la que deja que sólo una escriba.
       */
      const claim = await manager.getRepository(CollaboratorEntity).update(
        { id: reviewer.id, status: COLLABORATOR_STATUS_ENUM.PENDING },
        {
          status: COLLABORATOR_STATUS_ENUM.APPROVED,
          resolvedAt,
        },
      );
      if (claim.affected !== 1) {
        throw new Error('Ya registraste una decisión sobre este documento');
      }

      await manager
        .getRepository(DocumentEntity)
        .update(
          { id: documentId, status: DOCUMENT_STATUS_ENUM.PENDING_APPROVAL },
          { status: DOCUMENT_STATUS_ENUM.PENDING_SIGNATURE },
        );

      /**
       * El evento se registra AQUÍ, con el manager de esta transacción, y se publica después del
       * commit (ver `OutboxService`): si algo de lo de arriba revierte, el evento desaparece con
       * ello y nunca se anuncia una aprobación que no ocurrió.
       */
      await this.documentEventsProducer.enqueueApprovalEvent(
        manager,
        DOCUMENT_KAFKA_TOPICS.APPROVED,
        {
          documentId,
          fileName: document.fileName,
          actorUserId: currentUserId,
          collaboratorId: reviewer.id,
        },
      );
    });

    void this.auditService.create({
      documentId,
      operation: AuditAction.DOCUMENT_APPROVED,
      ipAddress: document.ipAddress ?? '0.0.0.0',
      users: [{ userId: currentUserId, action: AuditAction.DOCUMENT_APPROVED }],
    });

    /**
     * Ya confirmada la transacción: se publica lo pendiente, incluido lo que haya quedado atrasado
     * de intentos anteriores. Un fallo aquí no devuelve error — la aprobación ya está registrada y
     * el evento se reintenta en el siguiente `flushOutbox`.
     */
    await this.documentEventsProducer.flushOutbox();

    /**
     * `document.sent_to_sign` se publica aquí y no sólo al crear: es el evento que significa "el
     * documento entró a firma", y ese momento llega en dos puntos distintos según haya o no
     * aprobación. Un consumidor que espere a que la firma empiece no debería tener que saber
     * cuál de los dos caminos tomó el documento.
     */
    this.documentEventsProducer.emitSentToSign({
      documentId,
      fileName: document.fileName,
      actorUserId: currentUserId,
    });

    // Best-effort, igual que en `SubmitDocumentForAuthorizationUseCase`: la aprobación ya quedó
    // registrada y visible, así que un fallo de correo no debe deshacerla ni devolver un error.
    try {
      await this.documentService.notifyNextSigner(documentId);
      await this.documentService.sendSimpleSignatureInvitations(documentId);
    } catch (error) {
      this.logger.error(
        `Error notificando a los firmantes del documento ${documentId} tras su aprobación: ${error}`,
      );
    }

    /**
     * Los testigos se enteran en este momento y no al crearse el documento: mientras esperaba
     * aprobación el consumidor descartó su aviso, y sin esto nunca lo recibían (historia
     * "Corregir notificaciones por correo para testigos"). Aparte del bloque de arriba para que un
     * fallo al avisar a los firmantes no deje también sin aviso a los testigos.
     */
    try {
      await this.witnessNotificationService.announcePendingWitnesses(
        documentId,
        currentUserId,
      );
    } catch (error) {
      this.logger.error(
        `Error avisando a los testigos del documento ${documentId} tras su aprobación: ${error}`,
      );
    }

    return {
      success: true,
      message: 'Documento aprobado correctamente',
      data: { status: DOCUMENT_STATUS_ENUM.PENDING_SIGNATURE },
    };
  }
}
