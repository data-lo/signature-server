import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { CreateDocumentDto } from './dto/create-document.dto';
import { UpdateDocumentDto } from './dto/update-document.dto';
import { DocumentEntity } from './entities/document.entity';
import { Repository } from 'typeorm';
import { MinioService } from '../shared/minio/minio.service';
import { HashService } from '../shared/hash/hash.service';
import { UserService } from '../user/user.service';
import { FILE_STATUS_ENUM } from 'src/shared/minio/enums/file-status-enum';

@Injectable()
export class DocumentService {

  logger = new Logger();

  constructor(
    @InjectRepository(DocumentEntity)
    private readonly documentRepository: Repository<DocumentEntity>,
    private readonly minioService: MinioService,
    private readonly hashService: HashService,
    private readonly UserService: UserService

  ) { }
  async create(createDocumentDto: CreateDocumentDto, file:Express.Multer.File) {
    //Paso Uno, Subier el documento a Minio
    try{
    if(!file){
      throw new Error('Error, Documento Undefined');
    }
    const {signerId, createdById, coord } = createDocumentDto;
    const fileOriginalName = file.originalname;
    this.logger.log(`Nombre Original del Documento: ${fileOriginalName}`);
    const minioUploadDocumentResponse = await this.minioService.uploadObject(
      {
        file:file,
        name:file.originalname
      },
      "created_documents"
    );

    if(minioUploadDocumentResponse.status !== FILE_STATUS_ENUM.FILE_CREATED){
      throw new Error('Error Guardando Archivo en Bucket Minio');
    }
    
    const hashBefore = await this.hashService.generateFileHash(file);
    const signerUser = await this.UserService.findOne(signerId);
    const requestedByUser = await this.UserService.findOne(createdById);

    //TO DO SERVICIO DE PDF,
    //TO DO CONSTRUIR DOCUMENT URL AL MOMENTO DE SERVIR EL DOCUMENTO AL FRONT 

    const document = await this.documentRepository.create(
      {
        objectKey:minioUploadDocumentResponse.fileId,
        fileName:fileOriginalName,
        fileType:file.mimetype,
        totalPages:0, //TO DO, IMPLEMENTAR UN CONTADOR DE PAGINAS DEL PDF
        documentUrl:null, // IMPLEMENTAR SECURE URL URL-SERVER + URL MINIO
        ipAddress: '0.0.0.0', // IMPLEMENTAR EL INTERCEPTOR DE IP
        originalHash: hashBefore,
        signatureCoordinates: {left:50,right:50,top:50,bottom:50},
        requestedBy:requestedByUser,
        signer:signerUser
      }
    );

    await this.documentRepository.save(document);
    
    return document;
    
    }catch(error){
      throw new Error(`Error creando documento para firma ${error}`);
    }
  }

  findAll() {
    return `This action returns all document`;
  }

  async findOne(documentId: string): Promise<DocumentEntity> {
    return this.documentRepository.findOne({ where: { id: documentId } });
  }

  update(id: number, updateDocumentDto: UpdateDocumentDto) {
    return `This action updates a #${id} document`;
  }

  remove(id: number) {
    return `This action removes a #${id} document`;
  }
}
