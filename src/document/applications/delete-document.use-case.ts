import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { MinioService } from 'src/shared/minio/minio.service';
import { BUCKET_TYPES_ENUM } from 'src/shared/minio/enums/bucket-types.enum';
import { FILE_STATUS_ENUM } from 'src/shared/minio/enums/file-status-enum';

import { DocumentEntity } from '../entities/document.entity';
import { DOCUMENT_STATUS_ENUM } from '../enum/document-status.enum';
import { DocumentService } from '../document.service';

/**
 * `DELETE /document/:id`: borra un documento que todavía no salió a firmar.
 *
 * Acá el borrado sí es real —archivo y fila—, y puede serlo precisamente porque sólo se acepta
 * en CREATED: no hay firmas, ni auditoría de firma, ni nadie a quien le hayan pedido nada. En
 * cualquier estado posterior el documento es evidencia y no se borra.
 */
@Injectable()
export class DeleteDocumentUseCase {
  constructor(
    @InjectRepository(DocumentEntity)
    private readonly documentRepository: Repository<DocumentEntity>,
    private readonly minioService: MinioService,
    private readonly documentService: DocumentService,
  ) {}

  async execute(documentId: string, currentUserId: string) {
    try {
      const document = await this.documentService.findOne(documentId);

      if (document.createdBy !== currentUserId) {
        throw new ForbiddenException(
          'El documento no pertenece al usuario autenticado',
        );
      }

      if (document.status !== DOCUMENT_STATUS_ENUM.CREATED) {
        throw new BadRequestException(
          'Solo es posible eliminar documentos con estatus CREATED',
        );
      }

      const response = await this.minioService.deleteFile(
        document.objectKey,
        BUCKET_TYPES_ENUM.CREATED_DOCUMENTS,
      );

      if (response.message.status !== FILE_STATUS_ENUM.FILE_DELETED) {
        throw new Error('Error eliminando archivo en Minio');
      }

      await this.documentRepository.delete({ id: documentId });
      return {
        success: true,
        message: 'Documento eliminado exitosamente',
        data: {
          id: document.id,
        },
      };
    } catch (error) {
      if (
        error instanceof BadRequestException ||
        error instanceof NotFoundException ||
        error instanceof ForbiddenException
      )
        throw error;
      throw new Error(`Error eliminando documento: ${error}`);
    }
  }
}
