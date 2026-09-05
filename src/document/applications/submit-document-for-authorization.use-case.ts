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

import { DocumentEntity } from '../entities/document.entity';
import { DOCUMENT_STATUS_ENUM } from '../enum/document-status.enum';
import { DocumentService } from '../document.service';

/**
 * Saca el documento a firmar (`PATCH /document/:id/submit-for-authorization`).
 *
 * Es el punto de no retorno del borrador: a partir de acá el documento no se puede editar ni borrar,
 * porque lo que se les pide firmar a los invitados tiene que ser exactamente lo que vieron.
 *
 * El correo al primer firmante es best-effort: la solicitud ya quedó registrada y visible en su
 * bandeja, así que un fallo de SendGrid no debe deshacer el envío ni devolver un error a quien lo
 * mandó.
 */
@Injectable()
export class SubmitDocumentForAuthorizationUseCase {
  private readonly logger = new Logger(
    SubmitDocumentForAuthorizationUseCase.name,
  );

  constructor(
    @InjectRepository(DocumentEntity)
    private readonly documentRepository: Repository<DocumentEntity>,
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

    if (document.status !== DOCUMENT_STATUS_ENUM.CREATED) {
      throw new BadRequestException(
        `El documento no puede enviarse a autorización. Solo se permiten documentos con estatus '${DOCUMENT_STATUS_ENUM.CREATED}', el estatus actual es '${document.status}'`,
      );
    }

    document.status = DOCUMENT_STATUS_ENUM.PENDING;
    await this.documentRepository.save(document);

    void this.auditService.create({
      documentId,
      operation: AuditAction.DOCUMENT_SENT_TO_SIGN,
      ipAddress: document.ipAddress ?? '0.0.0.0',
      users: [
        { userId: currentUserId, action: AuditAction.DOCUMENT_SENT_TO_SIGN },
      ],
    });
    this.documentEventsProducer.emitSentToSign({
      documentId,
      fileName: document.fileName,
      actorUserId: currentUserId,
    });

    try {
      await this.documentService.notifyNextSigner(documentId);
    } catch (error) {
      this.logger.error(
        `Error notificando al firmante en turno del documento ${documentId}: ${error}`,
      );
    }

    return {
      success: true,
      message: 'Solicitud de autorización enviada exitosamente',
      data: null,
    };
  }
}
