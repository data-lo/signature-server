import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { BaseResponse } from 'src/interfaces/api-response.dto';
import { AuditService } from 'src/audit/audit.service';
import { AuditAction } from 'src/audit/schema/audit-document';
import { DocumentEventsProducer } from 'src/kafka/document-events.producer';
import { EmailService } from 'src/shared/email/email.service';
import { MinioService } from 'src/shared/minio/minio.service';
import { BUCKET_TYPES_ENUM } from 'src/shared/minio/enums/bucket-types.enum';
import { PdfSignatureService } from 'src/shared/document-signing/document-signing.service';

import { CollaboratorEntity } from '../entities/collaborator.entity';
import { DocumentEntity } from '../entities/document.entity';
import { DOCUMENT_STATUS_ENUM } from '../enum/document-status.enum';
import { COLABORATOR_TYPE_ENUM } from '../enum/colaborator-type.enum';
import {
  collaboratorDisplayName,
  collaboratorEmail,
} from '../utils/collaborator-display.util';
import { DocumentService } from '../document.service';

/**
 * Consuma la cancelación que se había solicitado (`PATCH /document/:id/confirm-cancellation`).
 *
 * Basta con que la confirme un firmante, igual que el rechazo: si alguno acepta cancelar, el
 * documento ya no va a completarse.
 *
 * Estampa el PDF como "CANCELADO" y lo mueve a su propio bucket en vez de borrarlo: sigue siendo
 * evidencia de lo que se pidió firmar y de quién alcanzó a firmarlo. Al final avisa a todos.
 */
@Injectable()
export class ConfirmDocumentCancellationUseCase {
  private readonly logger = new Logger(ConfirmDocumentCancellationUseCase.name);

  constructor(
    @InjectRepository(DocumentEntity)
    private readonly documentRepository: Repository<DocumentEntity>,
    @InjectRepository(CollaboratorEntity)
    private readonly collaboratorRepository: Repository<CollaboratorEntity>,
    private readonly minioService: MinioService,
    private readonly documentSigningSerivice: PdfSignatureService,
    private readonly emailService: EmailService,
    private readonly auditService: AuditService,
    private readonly documentEventsProducer: DocumentEventsProducer,
    private readonly documentService: DocumentService,
  ) {}

  async execute(
    documentId: string,
    currentUserId: string,
  ): Promise<BaseResponse<{ id: string }>> {
    const document = await this.documentService.findOne(documentId);

    if (document.status !== DOCUMENT_STATUS_ENUM.CANCELLATION_PENDING) {
      throw new BadRequestException(
        `El documento no puede cancelarse. Solo se permiten documentos con estatus '${DOCUMENT_STATUS_ENUM.CANCELLATION_PENDING}', el estatus actual es '${document.status}'`,
      );
    }

    const collaborators = await this.collaboratorRepository.find({
      where: { documentId },
      relations: { account: { user: true } },
    });

    const isSigner = collaborators.some(
      (c) =>
        c.account?.userId === currentUserId &&
        c.colaboratorType === COLABORATOR_TYPE_ENUM.SIGNER,
    );
    if (!isSigner) {
      throw new ForbiddenException('No eres firmante de este documento');
    }

    // Claim atómico (mismo criterio que sign()/reject()): "cualquier firmante puede confirmar"
    // significa que dos firmantes distintos (o el mismo, doblemente) podrían pasar el check de
    // arriba casi al mismo tiempo — sin este UPDATE condicionado, ambos estamparían y subirían
    // a MinIO, y todos los colaboradores recibirían el correo de cancelación duplicado.
    const cancelledAt = new Date();
    const claim = await this.documentRepository.update(
      { id: documentId, status: DOCUMENT_STATUS_ENUM.CANCELLATION_PENDING },
      { status: DOCUMENT_STATUS_ENUM.CANCELLED, cancelledAt },
    );
    if (claim.affected !== 1) {
      throw new BadRequestException(
        'La cancelación de este documento ya fue confirmada',
      );
    }
    document.status = DOCUMENT_STATUS_ENUM.CANCELLED;
    document.cancelledAt = cancelledAt;

    // Se cancela sobre la versión definitiva (con la hoja de firmas anexada), que es la que el
    // usuario venía viendo: el sello "CANCELADO" queda entonces sobre TODAS sus páginas, hoja
    // incluida, y no sobre una copia intermedia que nadie había visto nunca.
    const documentBuffer = await this.minioService.getFileInBytesFormat(
      document.objectKey,
      BUCKET_TYPES_ENUM.FINALIZED_DOCUMENTS,
    );
    const cancelledDocument =
      await this.documentSigningSerivice.stampCancelledWatermark(
        documentBuffer,
      );

    await this.minioService.uploadObject(
      {
        file: cancelledDocument,
        name: document.fileName,
        mimetype: 'application/pdf',
      },
      BUCKET_TYPES_ENUM.CANCELLED_DOCUMENTS,
      document.objectKey,
    );

    // status/cancelledAt ya se persistieron atómicamente en el claim de arriba.

    void this.auditService.create({
      documentId,
      operation: AuditAction.DOCUMENT_CANCELLED,
      ipAddress: document.ipAddress ?? '0.0.0.0',
      users: [
        { userId: currentUserId, action: AuditAction.DOCUMENT_CANCELLED },
      ],
    });
    this.documentEventsProducer.emitCancelled({
      documentId,
      fileName: document.fileName,
      actorUserId: currentUserId,
    });

    try {
      await Promise.all(
        collaborators.map((collaborator) =>
          this.emailService.sendDocumentCancelledNotification(
            collaboratorEmail(collaborator),
            collaboratorDisplayName(collaborator),
            document.fileName,
          ),
        ),
      );
    } catch (error) {
      this.logger.error(
        `Error notificando la cancelación del documento ${documentId}: ${error}`,
      );
    }

    return {
      success: true,
      message: 'Documento cancelado exitosamente',
      data: { id: documentId },
    };
  }
}
