import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { BaseResponse } from 'src/interfaces/api-response.dto';
import { MinioService } from 'src/shared/minio/minio.service';
import { BUCKET_TYPES_ENUM } from 'src/shared/minio/enums/bucket-types.enum';
import { FILE_STATUS_ENUM } from 'src/shared/minio/enums/file-status-enum';

import { SignatureCoordinatesDto } from '../dto/signature-coordinates.dto';
import { DocumentEntity } from '../entities/document.entity';
import { DOCUMENT_STATUS_ENUM } from '../enum/document-status.enum';
import { UpdateDocumentData } from '../interfaces/responses/document-update-response';
import { DocumentService } from '../document.service';

/**
 * `PATCH /document/:id`: mueve las coordenadas donde irán las firmas y, si se envía, reemplaza
 * el PDF.
 *
 * Sólo se permite mientras el documento esté en CREATED: una vez enviado a autorización alguien
 * pudo haber firmado ya, y cambiar el archivo o las posiciones bajo una firma existente
 * invalidaría la evidencia de lo que esa persona aceptó.
 */
@Injectable()
export class UpdateDocumentUseCase {
  constructor(
    @InjectRepository(DocumentEntity)
    private readonly documentRepository: Repository<DocumentEntity>,
    private readonly minioService: MinioService,
    private readonly documentService: DocumentService,
  ) {}

  async execute(
    documentId: string,
    currentUserId: string,
    signatureCoordinatesDto?: SignatureCoordinatesDto,
    fileToReplace?: Express.Multer.File,
  ): Promise<BaseResponse<UpdateDocumentData>> {
    try {
      const document = await this.documentService.findOne(documentId);

      if (!signatureCoordinatesDto && !fileToReplace) {
        throw new BadRequestException(
          'Debe proporcionar al menos un campo para actualizar: archivo o coordenadas de firma',
        );
      }

      if (document.createdBy !== currentUserId) {
        throw new ForbiddenException(
          'El documento no pertenece al usuario autenticado',
        );
      }

      if (document.status !== DOCUMENT_STATUS_ENUM.CREATED) {
        throw new BadRequestException(
          `El documento no puede actualizarse. Solo se permiten documentos con estatus '${DOCUMENT_STATUS_ENUM.CREATED}', el estatus actual es '${document.status}'`,
        );
      }

      if (fileToReplace) {
        const minioResponse = await this.minioService.replaceFile(
          document.objectKey,
          {
            file: fileToReplace,
            name: fileToReplace.originalname,
          },
          BUCKET_TYPES_ENUM.CREATED_DOCUMENTS,
        );

        if (minioResponse.status !== FILE_STATUS_ENUM.FILE_OVERWRITTEN) {
          throw new InternalServerErrorException(
            `Error al reemplazar el archivo en el almacenamiento. Estado recibido: '${minioResponse.status}'`,
          );
        }
      }

      await this.documentRepository.update(documentId, {
        signatureCoordinates: signatureCoordinatesDto,
      });

      const { secureUrl, expiresIn } = await this.minioService.getFile(
        document.objectKey,
        BUCKET_TYPES_ENUM.CREATED_DOCUMENTS,
      );

      const updatedDocument = await this.documentService.findOne(documentId);

      return {
        success: true,
        message: 'Documento actualizado exitosamente',
        data: {
          id: document.id,
          signatureCoordinates: updatedDocument.signatureCoordinates,
          secureUrl,
          expiresIn,
        },
      };
    } catch (error) {
      if (
        error instanceof BadRequestException ||
        error instanceof NotFoundException ||
        error instanceof ForbiddenException
      )
        throw error;
      throw new Error(`Error actualizando documento: ${error}`);
    }
  }
}
