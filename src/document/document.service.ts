import {
  BadGatewayException,
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DocumentEntity } from './entities/document.entity';
import { CreateDocumentDto } from './dto/create-document.dto';
import { UpdateDocumentDto } from './dto/update-document.dto';
import { DocumentEntity } from './entities/document.entity';
import { Repository } from 'typeorm';
import { MinioService } from '../shared/minio/minio.service';
import { HashService } from '../shared/hash/hash.service';
import { UserService } from '../user/user.service';
import { FILE_STATUS_ENUM } from 'src/shared/minio/enums/file-status-enum';
import { BUCKET_TYPES_ENUM } from 'src/shared/minio/enums/bucket-types.enum';
import { DOCUMENT_STATUS_ENUM } from './enum/document-status.enum';
import { min } from 'class-validator';

@Injectable()
export class DocumentService {
  logger = new Logger();

  constructor(
    @InjectRepository(DocumentEntity)
    private readonly documentRepository: Repository<DocumentEntity>,
    private readonly minioService: MinioService,
    private readonly hashService: HashService,
    private readonly UserService: UserService,
  ) {}
  async create(
    createDocumentDto: CreateDocumentDto,
    file: Express.Multer.File,
  ) {
    //Paso Uno, Subier el documento a Minio
    try {
      if (!file) {
        throw new Error('Error, Documento Undefined');
      }
      const { signerId, createdById, coord } = createDocumentDto;
      const fileOriginalName = file.originalname;
      this.logger.log(`Nombre Original del Documento: ${fileOriginalName}`);
      const minioUploadDocumentResponse = await this.minioService.uploadObject(
        {
          file: file,
          name: file.originalname,
        },
        'created_documents',
      );

      if (
        minioUploadDocumentResponse.status !== FILE_STATUS_ENUM.FILE_CREATED
      ) {
        throw new Error('Error Guardando Archivo en Bucket Minio');
      }

      const hashBefore = await this.hashService.generateFileHash(file);
      const signerUser = await this.UserService.findOne(signerId);
      const requestedByUser = await this.UserService.findOne(createdById);

      //TO DO SERVICIO DE PDF,
      //TO DO CONSTRUIR DOCUMENT URL AL MOMENTO DE SERVIR EL DOCUMENTO AL FRONT

      const document = await this.documentRepository.create({
        objectKey: minioUploadDocumentResponse.fileId,
        fileName: fileOriginalName,
        fileType: file.mimetype,
        totalPages: 0, //TO DO, IMPLEMENTAR UN CONTADOR DE PAGINAS DEL PDF
        documentUrl: null, // IMPLEMENTAR SECURE URL URL-SERVER + URL MINIO
        ipAddress: '0.0.0.0', // IMPLEMENTAR EL INTERCEPTOR DE IP
        originalHash: hashBefore,
        signatureCoordinates: { left: 50, right: 50, top: 50, bottom: 50 },
        requestedBy: requestedByUser,
        signer: signerUser,
      });

      await this.documentRepository.save(document);
      return document;
    } catch (error) {
      throw new Error(`Error creando documento para firma ${error}`);
    }
  }

  async findAll() {
    try {
      const documents = await this.documentRepository.find();
      return documents;
    } catch (error) {
      throw new Error(`Error obteniendo documentos`);
    }
  }

  async getDocumentMinioURL(documentId) {
    try {
      const document = await this.findOne(documentId);
      if (!document) {
        throw new NotFoundException(
          `Documento con id ${documentId}, no encontrato`,
        );
      }
      this.logger.log(document.objectKey);
      this.logger.log(document.status);

      try{
        if (document.status !== DOCUMENT_STATUS_ENUM.SIGNED) {
        this.logger.log('here')
        const fileResponse = await this.minioService.getFile(
          document.objectKey,
          BUCKET_TYPES_ENUM.CREATED_DOCUMENTS,
        );
        return fileResponse.secureUrl;
      }
      }catch(error){
        throw new Error(`Error obteniendo URL ${error}`)
      }

      const fileResponse = await this.minioService.getFile(
        document.objectKey,
        BUCKET_TYPES_ENUM.SIGNED_DOCUMENTS,
      );
      return fileResponse.secureUrl;
    } catch (error) {
      throw new Error(`Error obteniendo URL del Documento`);
    }
  }

  async findOne(documentId: string): Promise<DocumentEntity> {
    const document = this.documentRepository.findOne({
      where: { id: documentId },
    });
    if (!document) {
      throw new Error(`El documento con id ${documentId} no se encuentra`);
    }
    return document;
  }

  async update(id: string, updateDocumentDto: UpdateDocumentDto, fileToReplace?: Express.Multer.File) {
    try{
      const documentDb = await this.findOne(id);
      if(documentDb.status !== DOCUMENT_STATUS_ENUM.CREATED){
        throw new BadRequestException(`Solo es posible actualizar documentos con Estatus Created`)
      }
      if(fileToReplace){
        const objectKey = documentDb.objectKey
        const minioResponse = await this.minioService.replaceFile(
          objectKey,
          {
            file:fileToReplace,
            name:fileToReplace.originalname    
          },
          BUCKET_TYPES_ENUM.CREATED_DOCUMENTS
        );
        if(minioResponse.status !== FILE_STATUS_ENUM.FILE_OVERWRITTEN){
          throw new Error('Error remplazando el documento ')
        }
      }
      //TO DO DESAGREGAR DEL UPDATE DOCUMENT DTO LOS CAMPOS
      //QUE SON INTERNOS
      await this.documentRepository.update(id,updateDocumentDto)
      return await this.findOne(id);
    }catch(error){
      throw new Error(`Error actualizando documento`)
    }
  }

  async remove(documentId: string) {
    try {
      const document = await this.findOne(documentId);
      if (document.status !== DOCUMENT_STATUS_ENUM.CREATED) {
        throw new BadRequestException(
          'Solo es posible eliminar doucmentos con estatus CREATED',
        );
      }

      const response = await this.minioService.deleteFile(
        document.objectKey,
        BUCKET_TYPES_ENUM.CREATED_DOCUMENTS,
      );

      if(response.message.status === FILE_STATUS_ENUM.FILE_DELETED){
        await this.documentRepository.delete({id:documentId});
        return `document deleted`;
      }

    } catch (error) {
      throw new Error(`error eliminano un Documento: ${error}`);
    }
  }
}