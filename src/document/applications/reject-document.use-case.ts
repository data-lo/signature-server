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
import { UserService } from 'src/user/user.service';

import { CollaboratorEntity } from '../entities/collaborator.entity';
import { DocumentEntity } from '../entities/document.entity';
import { DOCUMENT_STATUS_ENUM } from '../enum/document-status.enum';
import { SIGNEE_STATUS_ENUM } from '../enum/signee-status.enum';
import { collaboratorDisplayName } from '../utils/collaborator-display.util';
import { isSignerTurn } from '../utils/next-signer.util';
import { DocumentService } from '../document.service';

/**
 * `PATCH /document/:id/reject`: el firmante autenticado se niega a firmar, si es su turno.
 *
 * Rechazar cierra el documento para todos y no sólo para quien rechazó: un documento que
 * necesita todas las firmas ya no puede completarse, y dejarlo abierto haría que los demás
 * siguieran recibiendo recordatorios de algo que nunca va a cerrarse.
 *
 * Al creador se le avisa con el motivo, que es lo único que le permite decidir qué hacer
 * después: rehacer el documento, hablar con quien rechazó, o dejarlo así.
 */
@Injectable()
export class RejectDocumentUseCase {
  private readonly logger = new Logger(RejectDocumentUseCase.name);

  constructor(
    @InjectRepository(DocumentEntity)
    private readonly documentRepository: Repository<DocumentEntity>,
    @InjectRepository(CollaboratorEntity)
    private readonly collaboratorRepository: Repository<CollaboratorEntity>,
    private readonly minioService: MinioService,
    private readonly userService: UserService,
    private readonly documentSigningSerivice: PdfSignatureService,
    private readonly emailService: EmailService,
    private readonly auditService: AuditService,
    private readonly documentEventsProducer: DocumentEventsProducer,
    private readonly documentService: DocumentService,
  ) {}

  async execute(
    documentId: string,
    currentUserId: string,
    reason: string,
  ): Promise<BaseResponse<{ id: string }>> {
    const document = await this.documentService.findOne(documentId);

    if (document.status !== DOCUMENT_STATUS_ENUM.PENDING) {
      throw new BadRequestException(
        `El documento no puede rechazarse. Solo se permiten documentos con estatus '${DOCUMENT_STATUS_ENUM.PENDING}', el estatus actual es '${document.status}'`,
      );
    }

    const { signerCollaborators, myParticipant } =
      await this.documentService.findOrLinkMySignerCollaborator(
        documentId,
        currentUserId,
        {
          account: { user: true },
        },
      );

    if (!myParticipant) {
      throw new ForbiddenException('No eres firmante de este documento');
    }

    if (myParticipant.status !== SIGNEE_STATUS_ENUM.PENDING) {
      throw new BadRequestException('Ya respondiste a esta solicitud de firma');
    }

    if (
      !isSignerTurn(myParticipant, signerCollaborators, document.isSequential)
    ) {
      throw new ForbiddenException(
        'Aún no es tu turno para revisar este documento',
      );
    }

    /**
     * Rechazar no exige tener la credencial de firma configurada, a diferencia de firmar.
     *
     * Antes sí la exigía, y era una trampa: un firmante sin identidad validada no podía firmar
     * —correcto— pero tampoco declinar, así que el documento se quedaba esperando para siempre
     * una respuesta que esa persona no tenía forma de dar. Rechazar no produce ninguna firma;
     * lo único que hace falta es ser el firmante en turno, que ya se comprobó arriba.
     */

    // Claim atómico (mismo criterio que sign(), ver su comentario): cierra la ventana de
    // carrera de un doble clic/doble pestaña rechazando antes de tocar MinIO/estampado.
    const claim = await this.collaboratorRepository.update(
      { id: myParticipant.id, status: SIGNEE_STATUS_ENUM.PENDING },
      { status: SIGNEE_STATUS_ENUM.REJECTED, cancellationReason: reason },
    );
    if (claim.affected !== 1) {
      throw new BadRequestException('Ya respondiste a esta solicitud de firma');
    }
    myParticipant.status = SIGNEE_STATUS_ENUM.REJECTED;
    myParticipant.cancellationReason = reason;

    // Estampo y muevo el documento a rechazados ANTES de marcar al colaborador como
    // rechazado: si el estampado o la subida a MinIO fallan, ni el colaborador ni el
    // documento quedan marcados, y el rechazo puede reintentarse sin quedar atascado.
    const documentBuffer = await this.minioService.getFileInBytesFormat(
      document.objectKey,
      BUCKET_TYPES_ENUM.CREATED_DOCUMENTS,
    );
    const rejectedDocument =
      await this.documentSigningSerivice.stampRejectedWatermark(documentBuffer);

    if (!rejectedDocument) {
      throw new Error('El servicio de rechazo no retornó un documento válido');
    }

    await this.minioService.uploadObject(
      {
        file: rejectedDocument,
        name: document.fileName,
        mimetype: 'application/pdf',
      },
      BUCKET_TYPES_ENUM.REJECTED_DOCUMENTS,
      document.objectKey,
    );

    document.rejectedAt = new Date();
    document.status = DOCUMENT_STATUS_ENUM.REJECTED;
    await this.documentRepository.save(document);

    // status/cancellationReason ya se persistieron atómicamente en el claim de arriba.

    void this.auditService.create({
      documentId,
      operation: AuditAction.DOCUMENT_REJECTED,
      ipAddress: document.ipAddress ?? '0.0.0.0',
      users: [{ userId: currentUserId, action: AuditAction.DOCUMENT_REJECTED }],
    });
    this.documentEventsProducer.emitRejected({
      documentId,
      fileName: document.fileName,
      actorUserId: currentUserId,
    });

    const creator = await this.userService.findOne(document.createdBy);
    try {
      await this.emailService.sendDocumentRejectedNotification(
        creator.email,
        `${creator.firstName} ${creator.lastName}`,
        collaboratorDisplayName(myParticipant),
        document.fileName,
        reason,
      );
    } catch (error) {
      this.logger.error(
        `Error notificando el rechazo del documento ${documentId}: ${error}`,
      );
    }

    return {
      success: true,
      message: 'Documento rechazado correctamente',
      data: { id: documentId },
    };
  }
}
