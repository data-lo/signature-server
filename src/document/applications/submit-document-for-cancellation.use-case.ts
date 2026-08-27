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
 * `PATCH /document/:id/submit-for-cancellation`: quien creó el documento pide cancelarlo.
 *
 * Es una solicitud y no la cancelación misma: un documento ya firmado por alguien no se deshace
 * por decisión unilateral de quien lo mandó, así que este paso avisa a los firmantes y deja la
 * cancelación pendiente de confirmarse.
 */
@Injectable()
export class SubmitDocumentForCancellationUseCase {
  private readonly logger = new Logger(
    SubmitDocumentForCancellationUseCase.name,
  );

  constructor(
    @InjectRepository(DocumentEntity)
    private readonly documentRepository: Repository<DocumentEntity>,
    @InjectRepository(CollaboratorEntity)
    private readonly collaboratorRepository: Repository<CollaboratorEntity>,
    private readonly emailService: EmailService,
    private readonly auditService: AuditService,
    private readonly documentEventsProducer: DocumentEventsProducer,
    private readonly documentService: DocumentService,
  ) {}

  async execute(
    documentId: string,
    currentUserId: string,
  ): Promise<BaseResponse<null>> {
    const document = await this.documentService.findOne(documentId);

    if (document.createdBy !== currentUserId) {
      throw new ForbiddenException(
        'El documento no pertenece al usuario autenticado',
      );
    }

    if (document.status !== DOCUMENT_STATUS_ENUM.SIGNED) {
      throw new BadRequestException(
        `El documento no puede enviarse a cancelación. Solo se permiten documentos con estatus '${DOCUMENT_STATUS_ENUM.SIGNED}', el estatus actual es '${document.status}'`,
      );
    }

    const signerCollaborators = await this.collaboratorRepository.find({
      where: { documentId, colaboratorType: COLABORATOR_TYPE_ENUM.SIGNER },
      relations: { account: { user: true } },
    });

    document.status = DOCUMENT_STATUS_ENUM.CANCELLATION_PENDING;
    await this.documentRepository.save(document);

    void this.auditService.create({
      documentId,
      operation: AuditAction.DOCUMENT_CANCELLATION_REQUESTED,
      ipAddress: document.ipAddress ?? '0.0.0.0',
      users: [
        {
          userId: currentUserId,
          action: AuditAction.DOCUMENT_CANCELLATION_REQUESTED,
        },
      ],
    });
    this.documentEventsProducer.emitCancellationRequested({
      documentId,
      fileName: document.fileName,
      actorUserId: currentUserId,
    });

    try {
      await Promise.all(
        signerCollaborators.map((collaborator) =>
          this.emailService.sendDocumentCancellationPendingNotification(
            collaboratorEmail(collaborator),
            document.fileName,
            collaboratorDisplayName(collaborator),
          ),
        ),
      );
    } catch (error) {
      this.logger.error(
        `Error notificando la solicitud de cancelación del documento ${documentId}: ${error}`,
      );
    }

    return {
      success: true,
      message: 'Solicitud de cancelación enviada exitosamente',
      data: null,
    };
  }
}
