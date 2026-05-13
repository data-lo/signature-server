import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DocumentEntity } from './entities/document.entity';
import { CreateDocumentDto } from './dto/create-document.dto';
import { UpdateDocumentDto } from './dto/update-document.dto';
import { Repository } from 'typeorm';
import { MinioService } from '../shared/minio/minio.service';
import { HashService } from '../shared/hash/hash.service';
import { UserService } from '../user/user.service';
import { FILE_STATUS_ENUM } from 'src/shared/minio/enums/file-status-enum';
import { BUCKET_TYPES_ENUM } from 'src/shared/minio/enums/bucket-types.enum';
import { DOCUMENT_STATUS_ENUM } from './enum/document-status.enum';
import { DocumentSignEventPayload } from './interfaces/document-sign-event-payload';
import { DocumentCancelPayload } from './interfaces/document-cancel-event-payload';
import { DocumentRejectPayload } from './interfaces/document-reject-event-payload';
import { PdfSignatureService } from 'src/shared/document-signing/document-signing.service';
import { SignatureService } from 'src/signature/signature.service';
import { DEFAULT_COORDINATES } from 'src/shared/document-signing/interfaces/default-signing-coordinates.interface';
import { EmailService } from 'src/shared/email/email.service';

@Injectable()
export class DocumentService {
  logger = new Logger(DocumentService.name);

  constructor(
    @InjectRepository(DocumentEntity)
    private readonly documentRepository: Repository<DocumentEntity>,
    private readonly minioService: MinioService,
    private readonly hashService: HashService,
    private readonly UserService: UserService,
    private readonly documentSigningSerivice: PdfSignatureService,
    private readonly signatureService: SignatureService,
    private readonly emailService: EmailService,
  ) { }
  /** Sube el archivo a Minio, genera su hash y registra el documento en la base de datos. */
  async create(
    createDocumentDto: CreateDocumentDto,
    file: Express.Multer.File,
    ip:string
  ) {
    try {
      if (!file) {
        throw new BadRequestException('Archivo no proporcionado');
      }
      const { signerId, createdById, coord } = createDocumentDto;
      const fileOriginalName = file.originalname;
      this.logger.log(`Nombre Original del Documento: ${fileOriginalName}`);
      const minioUploadDocumentResponse = await this.minioService.uploadObject(
        {
          file: file,
          name: file.originalname,
        },
        BUCKET_TYPES_ENUM.CREATED_DOCUMENTS,
      );
      const pdfPages = await this.documentSigningSerivice.getPdfPages(file);
    
      if (
        minioUploadDocumentResponse.status !== FILE_STATUS_ENUM.FILE_CREATED
      ) {
        throw new Error('Error guardando archivo en bucket Minio');
      }

      const hashBefore = await this.hashService.generateFileHash(file);
      const signerUser = await this.UserService.findOne(signerId);
      const requestedByUser = await this.UserService.findOne(createdById);


      const document = await this.documentRepository.create({
        objectKey: minioUploadDocumentResponse.fileId,
        fileName: fileOriginalName,
        fileType: file.mimetype,
        totalPages: pdfPages,
        ipAddress: ip, // IMPLEMENTAR EL INTERCEPTOR DE IP
        originalHash: hashBefore,
        signatureCoordinates: coord ? coord : DEFAULT_COORDINATES,
        requestedBy: requestedByUser,
        signer: signerUser,
      });

      await this.documentRepository.save(document);
      return document;
    } catch (error) {
      if (error instanceof BadRequestException || error instanceof NotFoundException) throw error;
      throw new Error(`Error creando documento para firma: ${error}`);
    }
  }

  /** Retorna todos los documentos registrados en la base de datos. */
  async findAll() {
    try {
      const documents = await this.documentRepository.find();
      return documents;
    } catch (error) {
      throw new Error(`Error obteniendo documentos`);
    }
  }

  /** Retorna los documentos asignados a un firmante, con filtro opcional por estatus. */
  async findDocumentsBySigner(
    signerId: string,
    status?: DOCUMENT_STATUS_ENUM,
  ): Promise<DocumentEntity[]> {
    try {
      const whereClause: Partial<DocumentEntity> = { signerId };
      if (status) {
        whereClause.status = status;
      }
      return await this.documentRepository.find({ where: whereClause });
    } catch (error) {
      throw new Error(
        `Error obteniendo documentos del firmante ${signerId}: ${error}`,
      );
    }
  }

  /** Genera y retorna la URL segura del archivo en Minio según el estatus del documento (firmado o no firmado). */
  async getDocumentMinioURL(documentId: string): Promise<string> {
    try {
      const document = await this.findOne(documentId);

      const bucket =
        document.status === DOCUMENT_STATUS_ENUM.CANCELLED
          ? BUCKET_TYPES_ENUM.CANCELLED_DOCUMENTS
          : document.status === DOCUMENT_STATUS_ENUM.REJECTED
            ? BUCKET_TYPES_ENUM.REJECTED_DOCUMENTS
            : document.status === DOCUMENT_STATUS_ENUM.SIGNED || document.status === DOCUMENT_STATUS_ENUM.CANCELLATION_PENDING
              ? BUCKET_TYPES_ENUM.SIGNED_DOCUMENTS
              : BUCKET_TYPES_ENUM.CREATED_DOCUMENTS;

      this.logger.log(`Status: ${document.status} | ObjectKey: ${document.objectKey}`);

      const fileResponse = await this.minioService.getFile(
        document.objectKey,
        bucket,
      );

      return fileResponse.secureUrl;
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
    id: string,
    updateDocumentDto: UpdateDocumentDto,
    fileToReplace?: Express.Multer.File,
  ) {
    try {
      const documentDb = await this.findOne(id);
      if (documentDb.status !== DOCUMENT_STATUS_ENUM.CREATED) {
        throw new BadRequestException(
          `Solo es posible actualizar documentos con estatus CREATED`,
        );
      }
      if (fileToReplace) {
        const objectKey = documentDb.objectKey;
        const minioResponse = await this.minioService.replaceFile(
          objectKey,
          {
            file: fileToReplace,
            name: fileToReplace.originalname,
          },
          BUCKET_TYPES_ENUM.CREATED_DOCUMENTS,
        );
        if (minioResponse.status !== FILE_STATUS_ENUM.FILE_OVERWRITTEN) {
          throw new Error('Error reemplazando el documento en Minio');
        }
      }
      //TO DO DESAGREGAR DEL UPDATE DOCUMENT DTO LOS CAMPOS
      //QUE SON INTERNOS
      await this.documentRepository.update(id, updateDocumentDto);
      return await this.findOne(id);
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
      return `document deleted`;
    } catch (error) {
      if (error instanceof BadRequestException || error instanceof NotFoundException) throw error;
      throw new Error(`Error eliminando documento: ${error}`);
    }
  }

  /** Cambia el estatus del documento de CREATED a PENDING y envía una notificación por email al firmante. */
  async submitForAuthorization(documentId: string): Promise<DocumentEntity> {
    try {
      const document = await this.findOne(documentId);

      if (document.status !== DOCUMENT_STATUS_ENUM.CREATED) {
        throw new BadRequestException(
          `Solo es posible enviar a autorización documentos con estatus CREATED`,
        );
      }

      document.status = DOCUMENT_STATUS_ENUM.PENDING;
      await this.documentRepository.save(document);

      const signer = await this.UserService.findOne(document.signerId);
      const signerFullName = `${signer.firstName} ${signer.lastName}`;

      await this.emailService.sendDocumentPendingNotification(
        signer.email,
        document.fileName,
        signerFullName,
      );

      return document;
    } catch (error) {
      if (error instanceof BadRequestException || error instanceof NotFoundException) throw error;
      throw new Error(`Error enviando documento a autorización: ${error}`);
    }
  }

  /** Obtiene la firma y el documento desde Minio, los fusiona en un PDF firmado, lo sube al bucket de documentos firmados y actualiza el estatus a SIGNED. */
  async mergeSignatureAndSave(payload: DocumentSignEventPayload) {
    try {
      const { signerId, documentId } = payload;
      const signerUser = await this.UserService.findOne(signerId);
      const document = await this.findOne(documentId);
      const coordinates = document.signatureCoordinates;

      const signatureId = signerUser.signatureId;
      const signature = await this.signatureService.findOne(signatureId);

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

      const fullName = signerUser.firstName + ' ' + signerUser.lastName
    
      const signedDocumentWithName = await this.documentSigningSerivice.addSignerName(
        signedDocument,
        fullName,
        coordinates
      );
      
      if (!signedDocumentWithName) {
        throw new Error('El servicio de firma no retornó un documento válido');
      }

      await this.minioService.uploadPdfAObject(
        {
          file: signedDocumentWithName,
          name: document.fileName,
          mimetype: 'application/pdf'
        },
        BUCKET_TYPES_ENUM.SIGNED_DOCUMENTS,
        fullName,
        document.objectKey,
      );

      const signedHash = await this.hashService.generateFileHash(signedDocumentWithName);
      document.signedHash = signedHash;
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

  /** Cambia el estatus del documento de SIGNED a CANCELLATION_PENDING y notifica al firmante por email. */
  async submitForCancellation(documentId: string): Promise<DocumentEntity> {
    try {
      const document = await this.findOne(documentId);

      if (document.status !== DOCUMENT_STATUS_ENUM.SIGNED) {
        throw new BadRequestException(
          `Solo es posible cancelar documentos con estatus SIGNED`,
        );
      }

      document.status = DOCUMENT_STATUS_ENUM.CANCELLATION_PENDING;
      await this.documentRepository.save(document);

      const signer = await this.UserService.findOne(document.signerId);
      const signerFullName = `${signer.firstName} ${signer.lastName}`;

      await this.emailService.sendDocumentCancellationPendingNotification(
        signer.email,
        document.fileName,
        signerFullName,
      );

      return document;
    } catch (error) {
      if (error instanceof BadRequestException || error instanceof NotFoundException) throw error;
      throw new Error(`Error enviando documento a cancelación: ${error}`);
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
        {
          file: cancelledDocument,
          name: document.fileName,
          mimetype: 'application/pdf',
        },
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

      return await this.findOne(document.id);
    } catch (error) {
      if (error instanceof NotFoundException) throw error;
      this.logger.error(`Error rechazando documento: ${error}`);
      throw new Error(`Error rechazando el documento: ${error}`);
    }
  }
}
