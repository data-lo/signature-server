// NestJS core
import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

// TypeORM
import { Repository } from 'typeorm';

// Entities
import { DocumentEntity } from './entities/document.entity';

// DTOs
import { CreateDocumentDto } from './dto/create-document.dto';
import { UpdateDocumentDto } from './dto/update-document.dto';

// Enums
import { DOCUMENT_STATUS_ENUM } from './enum/document-status.enum';
import { BUCKET_TYPES_ENUM } from 'src/shared/minio/enums/bucket-types.enum';
import { FILE_STATUS_ENUM } from 'src/shared/minio/enums/file-status-enum';

// Interfaces & payloads
import { BaseResponse } from 'src/interfaces/api-response.dto';
import { DocumentSignEventPayload } from './interfaces/document-sign-event-payload';
import { DocumentCancelPayload } from './interfaces/document-cancel-event-payload';
import { DocumentRejectPayload } from './interfaces/document-reject-event-payload';
import { DEFAULT_COORDINATES } from 'src/shared/document-signing/interfaces/default-signing-coordinates.interface';

// Services
import { MinioService } from '../shared/minio/minio.service';
import { HashService } from '../shared/hash/hash.service';
import { UserService } from '../user/user.service';
import { PdfSignatureService } from 'src/shared/document-signing/document-signing.service';
import { SignatureService } from 'src/signature/signature.service';
import { EmailService } from 'src/shared/email/email.service';
import { GetDocumentsQueryDto } from './dto/get-documents-query.dto';
import { SignatureCoordinatesDto } from './dto/signature-coordinates.dto';
import { UpdateDocumentData } from './interfaces/responses/document-update-response';
import { find } from 'rxjs';

@Injectable()
export class DocumentService {
  logger = new Logger(DocumentService.name);

  private readonly STATUS_BUCKET_MAP: Partial<Record<DOCUMENT_STATUS_ENUM, BUCKET_TYPES_ENUM>> = {
    [DOCUMENT_STATUS_ENUM.CANCELLED]: BUCKET_TYPES_ENUM.CANCELLED_DOCUMENTS,
    [DOCUMENT_STATUS_ENUM.REJECTED]: BUCKET_TYPES_ENUM.REJECTED_DOCUMENTS,
    [DOCUMENT_STATUS_ENUM.SIGNED]: BUCKET_TYPES_ENUM.SIGNED_DOCUMENTS,
    [DOCUMENT_STATUS_ENUM.CANCELLATION_PENDING]: BUCKET_TYPES_ENUM.SIGNED_DOCUMENTS,
  }

  constructor(
    @InjectRepository(DocumentEntity)
    private readonly documentRepository: Repository<DocumentEntity>,
    private readonly minioService: MinioService,
    private readonly hashService: HashService,
    private readonly userService: UserService,
    private readonly documentSigningSerivice: PdfSignatureService,
    private readonly signatureService: SignatureService,
    private readonly emailService: EmailService,
  ) { }

  /** Sube el archivo a Minio, genera su hash y registra el documento en la base de datos. */
  async create(
    createDocumentDto: CreateDocumentDto,
    file: Express.Multer.File,
    ip: string,
  ): Promise<BaseResponse> {
    try {
      if (!file) {
        throw new BadRequestException('Archivo no proporcionado');
      }


      const { signerId, createdBy, signatureCoordinates } = createDocumentDto;

      const minioUploadDocumentResponse = await this.minioService.uploadObject(
        { file, name: file.originalname },
        BUCKET_TYPES_ENUM.CREATED_DOCUMENTS,
      );

      if (minioUploadDocumentResponse.status !== FILE_STATUS_ENUM.FILE_CREATED) {
        throw new Error('Error guardando archivo en bucket Minio');
      }

      const pdfPages = await this.documentSigningSerivice.getPdfPages(file);
      const hashBefore = await this.hashService.generateFileHash(file);

      await this.userService.findOne(signerId);
      await this.userService.findOne(createdBy);

      const document = this.documentRepository.create({
        objectKey: minioUploadDocumentResponse.fileId,
        fileName: file.originalname,
        fileType: file.mimetype,
        totalPages: pdfPages,
        ipAddress: ip,
        originalHash: hashBefore,
        signatureCoordinates: signatureCoordinates ?? DEFAULT_COORDINATES,
        createdBy,
        signerId,
      });

      const savedDocument = await this.documentRepository.save(document);

      const url = await this.getDocumentMinioURL(savedDocument.id);

      const newDocumentObject = await this.documentRepository.findOne({
        where: {
          id: savedDocument.id,
        },
        relations: {
          requestedBy: true,
          signer: true
        },
      });

      return {
        success: true,
        message: 'Documento registrado y pendiente de firma correctamente',
        data: {
          id: savedDocument.id,
          fileName: savedDocument.fileName,
          fileType: savedDocument.fileType,
          totalPages: savedDocument.totalPages,
          signer: `${newDocumentObject.signer.firstName} ${newDocumentObject.signer.lastName}`,
          creator: `${newDocumentObject.requestedBy.firstName} ${newDocumentObject.requestedBy.lastName}`,
          status: savedDocument.status,
          secureUrl: url.secureUrl,
          expiresIn: url.expiresIn,
        },
      };

    } catch (error) {
      if (error instanceof BadRequestException || error instanceof NotFoundException) throw error;
      throw new Error(`Error creando documento para firma: ${error}`);
    }
  }

  async findWithFilters(query: GetDocumentsQueryDto) {
    const { id, signerId, email, status, dateFrom, dateTo, page, limit, withUrl } = query;

    const qb = this.documentRepository
      .createQueryBuilder('document')
      .leftJoinAndSelect('document.requestedBy', 'requester')
      .leftJoinAndSelect('document.signer', 'signer')
      .orderBy('document.createdAt', 'DESC')
      .skip((page - 1) * limit)
      .take(limit);

    if (id) {
      qb.andWhere('document.id = :id', { id });
    }

    if (signerId) {
      qb.andWhere('signer.id = :signerId', { signerId });
    }

    if (email) {
      qb.andWhere('(signer.email = :email OR requester.email = :email)', { email });
    }

    if (status) {
      qb.andWhere('document.status = :status', { status });
    }

    if (dateFrom) {
      qb.andWhere('document.createdAt >= :dateFrom', { dateFrom: new Date(dateFrom) });
    }

    if (dateTo) {
      qb.andWhere('document.createdAt <= :dateTo', { dateTo: new Date(dateTo) });
    }

    const [documents, total] = await qb.getManyAndCount();

    if (!documents.length) {
      throw new NotFoundException('No se encontraron documentos con los filtros indicados');
    }

    const data = await Promise.all(
      documents.map(async (doc) => {
        if (!withUrl) {
          return {
            id: doc.id,
            fileName: doc.fileName,
            fileType: doc.fileType,
            signer: `${doc.signer.firstName} ${doc.signer.lastName}`,
            creator: `${doc.requestedBy.firstName} ${doc.requestedBy.lastName}`,
            totalPages: doc.totalPages + 1,
            status: doc.status,
            createdAt: doc.createdAt
          };
        }

        const bucket = this.STATUS_BUCKET_MAP[doc.status] ?? BUCKET_TYPES_ENUM.CREATED_DOCUMENTS;

        const { secureUrl, expiresIn } = await this.minioService.getFile(doc.objectKey, bucket);

        return {
          id: doc.id,
          fileName: doc.fileName,
          fileType: doc.fileType,
          totalPages: doc.totalPages,
          signer: `${doc.signer.firstName} ${doc.signer.lastName}`,
          status: doc.status,
          createdAt: doc.createdAt,
          secureUrl,
          expiresIn,
        };
      }),
    );

    return {
      success: true,
      message: 'Documentos obtenidos correctamente',
      data,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
        hasNextPage: page < Math.ceil(total / limit),
        hasPrevPage: page > 1,
      },
    };
  }

  /** Genera y retorna la URL segura del archivo en Minio según el estatus del documento. */
  async getDocumentMinioURL(documentId: string) {
    try {
      const document = await this.findOne(documentId);

      const bucketByStatus: Record<DOCUMENT_STATUS_ENUM, BUCKET_TYPES_ENUM> = {
        [DOCUMENT_STATUS_ENUM.CANCELLED]: BUCKET_TYPES_ENUM.CANCELLED_DOCUMENTS,
        [DOCUMENT_STATUS_ENUM.REJECTED]: BUCKET_TYPES_ENUM.REJECTED_DOCUMENTS,
        [DOCUMENT_STATUS_ENUM.SIGNED]: BUCKET_TYPES_ENUM.SIGNED_DOCUMENTS,
        [DOCUMENT_STATUS_ENUM.CANCELLATION_PENDING]: BUCKET_TYPES_ENUM.SIGNED_DOCUMENTS,
        [DOCUMENT_STATUS_ENUM.PENDING]: BUCKET_TYPES_ENUM.CREATED_DOCUMENTS,
        [DOCUMENT_STATUS_ENUM.CREATED]: BUCKET_TYPES_ENUM.CREATED_DOCUMENTS,
        [DOCUMENT_STATUS_ENUM.EXPIRED]: BUCKET_TYPES_ENUM.CREATED_DOCUMENTS,
      };

      const bucket = bucketByStatus[document.status];

      const fileResponse = await this.minioService.getFile(document.objectKey, bucket);

      return fileResponse;
    } catch (error) {
      if (error instanceof NotFoundException) throw error;
      throw new Error(`Error obteniendo URL del Documento: ${error}`);
    }
  }

  /** Busca un documento por su UUID y lanza NotFoundException si no existe. */
  async findOne(documentId: string): Promise<DocumentEntity> {
    const document = await this.documentRepository.findOne({
      where: { id: documentId },
    });
    if (!document) {
      throw new NotFoundException(`El documento con id ${documentId} no se encuentra`);
    }
    return document;
  }

  /** Actualiza los datos de un documento y opcionalmente reemplaza su archivo en Minio. Solo permite documentos en estatus CREATED. */
  async update(
    documentId: string,
    signatureCoordinatesDto?: SignatureCoordinatesDto,
    fileToReplace?: Express.Multer.File,
  ): Promise<BaseResponse<UpdateDocumentData>> {
    try {
      const document = await this.findOne(documentId);

      if (!signatureCoordinatesDto && !fileToReplace) {
        throw new BadRequestException(
          'Debe proporcionar al menos un campo para actualizar: archivo o coordenadas de firma',
        );
      }

      if (!document) {
        throw new NotFoundException(`El documento con id ${documentId} no se encuentra`);
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
            name: fileToReplace.originalname
          },
          BUCKET_TYPES_ENUM.CREATED_DOCUMENTS,
        );

        if (minioResponse.status !== FILE_STATUS_ENUM.FILE_OVERWRITTEN) {
          throw new InternalServerErrorException(
            `Error al reemplazar el archivo en el almacenamiento. Estado recibido: '${minioResponse.status}'`,
          );
        }
      }

      await this.documentRepository.update(documentId, { signatureCoordinates: signatureCoordinatesDto });

      const { secureUrl, expiresIn } = await this.minioService.getFile(document.objectKey, BUCKET_TYPES_ENUM.CREATED_DOCUMENTS);

      const updatedDocument = await this.findOne(documentId);

      return {
        success: true,
        message: "Documento actualizado exitosamente",
        data: {
          id: document.id,
          signatureCoordinates: updatedDocument.signatureCoordinates,
          secureUrl,
          expiresIn,
        }
      }


    } catch (error) {
      if (error instanceof BadRequestException || error instanceof NotFoundException) throw error;
      throw new Error(`Error actualizando documento: ${error}`);
    }
  }

  /** Elimina el archivo de Minio y el registro del documento. Solo permite documentos en estatus CREATED. */
  async remove(documentId: string) {
    try {
      const document = await this.findOne(documentId);
      if (document.status !== DOCUMENT_STATUS_ENUM.CREATED) {
        throw new BadRequestException('Solo es posible eliminar documentos con estatus CREATED');
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
        message: "Documento eliminado exitosamente",
        data: {
          id: document.id,
        }
      }
    } catch (error) {
      if (error instanceof BadRequestException || error instanceof NotFoundException) throw error;
      throw new Error(`Error eliminando documento: ${error}`);
    }
  }
  async submitForAuthorization(documentId: string): Promise<BaseResponse<null>> {
    const document = await this.findOne(documentId);

    if (document.status !== DOCUMENT_STATUS_ENUM.CREATED) {
      throw new BadRequestException(
        `El documento no puede enviarse a autorización. Solo se permiten documentos con estatus '${DOCUMENT_STATUS_ENUM.CREATED}', el estatus actual es '${document.status}'`,
      );
    }

    const signer = await this.userService.findOne(document.signerId);

    document.status = DOCUMENT_STATUS_ENUM.PENDING;
    await this.documentRepository.save(document);

    await this.emailService.sendDocumentPendingNotification(
      signer.email,
      document.fileName,
      `${signer.firstName} ${signer.lastName}`,
    );

    return {
      success: true,
      message: 'Solicitud de autorización enviada exitosamente',
      data: null,
    };
  }

  async requestCancellation(documentId: string): Promise<BaseResponse<null>> {
    const document = await this.findOne(documentId);

    if (document.status !== DOCUMENT_STATUS_ENUM.SIGNED) {
      throw new BadRequestException(
        `El documento no puede enviarse a cancelación. Solo se permiten documentos con estatus '${DOCUMENT_STATUS_ENUM.SIGNED}', el estatus actual es '${document.status}'`,
      );
    }

    const signer = await this.userService.findOne(document.signerId);

    document.status = DOCUMENT_STATUS_ENUM.CANCELLATION_PENDING;
    await this.documentRepository.save(document);

    await this.emailService.sendDocumentCancellationPendingNotification(
      signer.email,
      document.fileName,
      `${signer.firstName} ${signer.lastName}`,
    );

    return {
      success: true,
      message: 'Solicitud de cancelación enviada exitosamente',
      data: null,
    };
  }

  /** Obtiene la firma y el documento desde Minio, los fusiona en un PDF firmado, lo sube al bucket de documentos firmados y actualiza el estatus a SIGNED. */
  async mergeSignatureAndSave(payload: DocumentSignEventPayload) {
    try {
      const { signerId, documentId } = payload;
      const signerUser = await this.userService.findOne(signerId);
      const document = await this.findOne(documentId);
      const coordinates = document.signatureCoordinates;

      const signature = await this.signatureService.findOne(signerUser.signatureId);

      const signatureObjectBuffer = await this.minioService.getFileInBytesFormat(
        signature.signatureObjectKey,
        BUCKET_TYPES_ENUM.SIGNATURE_IMAGES,
      );
      this.logger.debug('Signature buffer obtenido');

      const documentObjectBuffer = await this.minioService.getFileInBytesFormat(
        document.objectKey,
        BUCKET_TYPES_ENUM.CREATED_DOCUMENTS,
      );
      this.logger.debug('Documento a firmar obtenido');

      const signedDocument = await this.documentSigningSerivice.mergeSignatureIntoPdf(
        documentObjectBuffer,
        signatureObjectBuffer,
        coordinates,
      );

      const fullName = `${signerUser.firstName} ${signerUser.lastName}`;

      const signedDocumentWithName = await this.documentSigningSerivice.addSignerName(
        signedDocument,
        fullName,
        coordinates,
      );

      if (!signedDocumentWithName) {
        throw new Error('El servicio de firma no retornó un documento válido');
      }

      await this.minioService.uploadPdfAObject(
        { file: signedDocumentWithName, name: document.fileName, mimetype: 'application/pdf' },
        BUCKET_TYPES_ENUM.SIGNED_DOCUMENTS,
        fullName,
        document.objectKey,
      );

      document.signedHash = await this.hashService.generateFileHash(signedDocumentWithName);
      document.signedAt = new Date();
      document.status = DOCUMENT_STATUS_ENUM.SIGNED;
      await this.documentRepository.save(document);

      return await this.findOne(document.id);
    } catch (error) {
      if (error instanceof NotFoundException) throw error;
      this.logger.error(`Error estampando documento: ${error}`);
      throw new Error(`Error estampando el documento: ${error}`);
    }
  }


  /** Obtiene el documento firmado desde Minio, estampa la marca de agua CANCELADO en todas las páginas, lo sube al bucket de cancelados y actualiza el estatus a CANCELLED. */
  async cancelDocument(payload: DocumentCancelPayload): Promise<DocumentEntity> {
    try {
      const { documentId } = payload;
      const document = await this.findOne(documentId);

      const documentBuffer = await this.minioService.getFileInBytesFormat(
        document.objectKey,
        BUCKET_TYPES_ENUM.SIGNED_DOCUMENTS,
      );
      this.logger.debug(`Documento firmado obtenido para cancelación | documentId: ${documentId}`);

      const cancelledDocument = await this.documentSigningSerivice.stampCancelledWatermark(documentBuffer);

      if (!cancelledDocument) {
        throw new Error('El servicio de cancelación no retornó un documento válido');
      }

      await this.minioService.uploadObject(
        { file: cancelledDocument, name: document.fileName, mimetype: 'application/pdf' },
        BUCKET_TYPES_ENUM.CANCELLED_DOCUMENTS,
        document.objectKey,
      );

      document.cancelledAt = new Date();
      document.status = DOCUMENT_STATUS_ENUM.CANCELLED;
      await this.documentRepository.save(document);

      return await this.findOne(document.id);
    } catch (error) {
      if (error instanceof NotFoundException) throw error;
      this.logger.error(`Error cancelando documento: ${error}`);
      throw new Error(`Error cancelando el documento: ${error}`);
    }
  }

  /** Obtiene el documento original desde Minio, estampa la marca de agua RECHAZADO en todas las páginas, lo sube al bucket de rechazados y actualiza el estatus a REJECTED. */
  async rejectDocument(payload: DocumentRejectPayload): Promise<DocumentEntity> {
    try {
      const { documentId } = payload;
      const document = await this.findOne(documentId);

      const documentBuffer = await this.minioService.getFileInBytesFormat(
        document.objectKey,
        BUCKET_TYPES_ENUM.CREATED_DOCUMENTS,
      );
      this.logger.debug(`Documento original obtenido para rechazo | documentId: ${documentId}`);

      const rejectedDocument = await this.documentSigningSerivice.stampRejectedWatermark(documentBuffer);

      if (!rejectedDocument) {
        throw new Error('El servicio de rechazo no retornó un documento válido');
      }

      await this.minioService.uploadObject(
        { file: rejectedDocument, name: document.fileName, mimetype: 'application/pdf' },
        BUCKET_TYPES_ENUM.REJECTED_DOCUMENTS,
        document.objectKey,
      );

      document.rejectedAt = new Date();
      document.status = DOCUMENT_STATUS_ENUM.REJECTED;
      await this.documentRepository.save(document);

      return await this.findOne(document.id);
    } catch (error) {
      if (error instanceof NotFoundException) throw error;
      this.logger.error(`Error rechazando documento: ${error}`);
      throw new Error(`Error rechazando el documento: ${error}`);
    }
  }
}