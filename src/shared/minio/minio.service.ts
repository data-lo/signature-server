import { Injectable, Logger } from '@nestjs/common';
import * as Minio from 'minio';
import { MinioFileI } from './interfaces/minio.file.interface';
import { FILE_STATUS_ENUM } from './enums/file-status-enum';
import { v4 as uuid4 } from 'uuid';
import { GetFileResponse } from './interfaces/minio.get-file-response.interface';
import { BUCKET_TYPES_ENUM } from './enums/bucket-types.enum';

@Injectable()
export class MinioService {

  private readonly logger = new Logger(MinioService.name);

  minioClient: any;

  MINIO_CREATED_DOCUMENTS_BUCKET: any;
  MINIO_SIGNED_DOCUMENTS_BUCKET: any;
  MINIO_CANCELLED_DOCUMENTS_BUCKET: any;
  MINIO_OFICIAL_CARDS_BUCKET: any;
  MINIO_SIGNATURE_IMAGES_BUCKET: any;

  MINIO_HOST: any;
  MINIO_PORT: any;
  MINIO_API: any;

  constructor() {
    this.setMinioClient();
  }

  private getMinioClient() {
    if (!this.minioClient) {
      this.setMinioClient();
      return this.minioClient;
    }
    return this.minioClient;
  }

  private setMinioClient() {
    if (!process.env.MINIO_ACCESS_KEY || !process.env.MINIO_SECRET_KEY) {
      throw new Error(
        '¡Las API keys del servicio de MinIO no están configuradas!',
      );
    }

    this.minioClient = new Minio.Client({
      endPoint: process.env.MINIO_HOST,
      port: Number(process.env.MINIO_PORT),
      useSSL: false,
      accessKey: process.env.MINIO_ACCESS_KEY,
      secretKey: process.env.MINIO_SECRET_KEY,
    });

    if (
      !process.env.MINIO_CREATED_DOCUMENTS_BUCKET ||
      !process.env.MINIO_SIGNED_DOCUMENTS_BUCKET ||
      !process.env.MINIO_CANCELLED_DOCUMENTS_BUCKET ||
      !process.env.MINIO_OFICIAL_CARDS_BUCKET ||
      !process.env.MINIO_SIGNATURE_IMAGES_BUCKET
    ) {
      throw new Error(
        '¡Los buckets de MinIO no están definidos en las variables de entorno!',
      );
    }

    this.MINIO_CREATED_DOCUMENTS_BUCKET =
      process.env.MINIO_CREATED_DOCUMENTS_BUCKET;
    this.MINIO_SIGNED_DOCUMENTS_BUCKET =
      process.env.MINIO_SIGNED_DOCUMENTS_BUCKET;
    this.MINIO_CANCELLED_DOCUMENTS_BUCKET =
      process.env.MINIO_CANCELLED_DOCUMENTS_BUCKET;
    this.MINIO_OFICIAL_CARDS_BUCKET = process.env.MINIO_OFICIAL_CARDS_BUCKET;
    this.MINIO_SIGNATURE_IMAGES_BUCKET =
      process.env.MINIO_SIGNATURE_IMAGES_BUCKET;
    this.MINIO_HOST = process.env.MINIO_HOST;
    this.MINIO_PORT = process.env.MINIO_PORT;
    this.MINIO_API = process.env.MINIO_API;
    return;
  }

  private getBucketByType(type: BUCKET_TYPES_ENUM) {
    switch (type) {
      case BUCKET_TYPES_ENUM.CREATED_DOCUMENTS:
        return this.MINIO_CREATED_DOCUMENTS_BUCKET;
      case BUCKET_TYPES_ENUM.SIGNED_DOCUMENTS:
        return this.MINIO_SIGNED_DOCUMENTS_BUCKET;
      case BUCKET_TYPES_ENUM.CANCELLED_DOCUMENTS:
        return this.MINIO_CANCELLED_DOCUMENTS_BUCKET;
      case BUCKET_TYPES_ENUM.OFICIAL_CARDS:
        return this.MINIO_OFICIAL_CARDS_BUCKET;
      case BUCKET_TYPES_ENUM.SIGNATURE_IMAGES:
        return this.MINIO_SIGNATURE_IMAGES_BUCKET;
      default:
        throw new Error('Tipo de bucket no reconocido');
    }
  }

  checkSignatureFileObjects(files: Array<Express.Multer.File>) {
    let signatureFile;
    let oficialCardPdfFile;
    try {
      signatureFile = files.find((f) => f.mimetype === 'image/png');
    } catch (error) {
      console.log('Signature file not found in the uploaded files.');
    }

    try {
      oficialCardPdfFile = files.find((f) => f.mimetype == 'application/pdf');
    } catch (error) {
      console.log('Official card PDF file not found in the uploaded files.');
    }

    return {
      signatureFile,
      oficialCardPdfFile,
    };
  }

  checkSignatureFileObject(file: Express.Multer.File) {
    try {
      switch (file.mimetype) {
        case 'image/png':
          return BUCKET_TYPES_ENUM.SIGNATURE_IMAGES;
        case 'application/pdf':
          return BUCKET_TYPES_ENUM.OFICIAL_CARDS;
        default:
          throw new Error('Formato de archivo no esperado');
      }
    } catch (error) {
      throw new Error('El archivo no corresponde al formato');
    }
  }

  async uploadObject(
    file: MinioFileI,
    type: BUCKET_TYPES_ENUM,
    objectKey?:string
  ): Promise<{
    status: FILE_STATUS_ENUM;
    fileId: string;
    bucket: string;
    fileType: string;
  }> {
    try {
      const minioClient = await this.getMinioClient();
      const bucketName = await this.getBucketByType(type);

      await minioClient.bucketExists(bucketName, (err, exists) => {
        if (err) {
          throw new Error(
            `Error al verificar la existencia del bucket: ${err}`,
          );
        }
      });

      this.logger.log(file.name);
      const extension = file.name.split('.').pop()?.toLowerCase();
      this.logger.log(`Extension Document ${extension}`);
          
      if(!objectKey){
        objectKey = `${uuid4()}.${extension}`;  
      }

      this.logger.log(`Nombre Documento ${objectKey}`)
      const {buffer:fileBuffer,mimetype} = this.resolveFileData(file);
      if (!fileBuffer) {
        throw new Error('El archivo no contiene datos válidos');
      }

      await minioClient.putObject(bucketName, objectKey, fileBuffer, {
        'Content-Type': mimetype,
      });

      return {
        fileType: mimetype,
        bucket: bucketName,
        status: FILE_STATUS_ENUM.FILE_CREATED,
        fileId: objectKey,
      };
    } catch (error) {
      throw new Error(`Error al subir archivos a MinIO: ${error}`);
    }
  }

  async getFile(
    fileId: string,
    bucketType: BUCKET_TYPES_ENUM,
    expiresIn: number = 24 * 60 * 60,
  ): Promise<GetFileResponse> {
    try {
      let fileName = fileId;
      const minioClient = await this.getMinioClient();
      const bucketName = await this.getBucketByType(bucketType);
      const exists = await minioClient.bucketExists(bucketName);

      if (!exists) {
        throw new Error(`El bucket ${bucketName} no existe en MinIO`);
      }

      if(!fileName.includes('.')){
        fileName = this.addFileExtension(fileId, bucketType);
      }

      try {
        this.logger.log(`Consulta del file en Minio ${await minioClient.statObject(bucketName, fileName)}`);
      } catch (error) {
        throw new Error(
          `El archivo con ID ${fileId} no existe en el bucket ${bucketName}`,
        );
      }

      const secureUrl = await minioClient.presignedGetObject(
        bucketName,
        fileName,
        expiresIn,
      );

      return {
        fileId,
        secureUrl,
        expiresIn,
      };
    } catch (error) {
      throw new Error(`Error al obtener el archivo de MinIO: ${error}`);
    }
  }

  async replaceFile(
    fileName: string,
    file: MinioFileI,
    type: BUCKET_TYPES_ENUM,
  ): Promise<{
    status: FILE_STATUS_ENUM;
    fileId: string;
    bucket: string;
    fileType: string;
  }> {
    try {
      const minioClient = this.getMinioClient();
      this.logger.debug(fileName);

      const bucketName = this.getBucketByType(type);
      this.logger.debug(bucketName);
      try {
        const fileData = await minioClient.statObject(bucketName, fileName);
        this.logger.log(fileData);
      } catch (error) {
        throw new Error(
          `El archivo con ID ${fileName} no existe en el bucket ${bucketName}`,
        );
      }

      await minioClient.removeObject(bucketName, fileName);
      this.logger.debug(
        `Archivo ${fileName} eliminado del bucket ${bucketName}`,
      );
      const {buffer: fileBuffer, mimetype} = this.resolveFileData(file);
      if (!fileBuffer) {
        throw new Error('El archivo no contiene datos válidos');
      }

      try {
        await minioClient.putObject(bucketName, fileName, fileBuffer, {
          'Content-Type': mimetype,
        });
      } catch (error) {
        this.logger.error(`Error al subir el nuevo archivo a MinIO: ${error}`);
        throw new Error(`Error al subir el nuevo archivo a MinIO: ${error}`);
      }

      this.logger.log(
        `Archivo ${fileName} subido al bucket ${bucketName} con éxito`,
      );

      return {
        fileType: mimetype,
        bucket: bucketName,
        status: FILE_STATUS_ENUM.FILE_OVERWRITTEN,
        fileId: fileName,
      };
    } catch (error) {
      throw new Error(`Error al reemplazar el archivo en MinIO: ${error}`);
    }
  }

  async deleteFile(fileName,bucketType:BUCKET_TYPES_ENUM){
    try{
      const minioClient = this.getMinioClient();
      this.logger.debug(fileName);

      this.logger.warn('SOLO SE DEBERÍA PODER BORRAR ARCHIVOS EN STATUS CREATED');
      const bucketName = this.getBucketByType(bucketType);
      this.logger.debug(bucketName);
      try {
        const fileData = await minioClient.statObject(bucketName, fileName);
        this.logger.log(fileData);
      } catch (error) {
        throw new Error(
          `El archivo con ID ${fileName} no existe en el bucket ${bucketName}`,
        );
      }

      await minioClient.removeObject(bucketName, fileName);
      this.logger.warn(
        `Archivo ${fileName} eliminado del bucket ${bucketName}`,
      );
      return {
        message:{
          status:FILE_STATUS_ENUM.FILE_DELETED,
          fileId:fileName
        }
      }

    }catch(error){
      throw new Error(`Error eliminando un documento del bucket ${error}`)
    }

  }


  async getFileInBytesFormat(fileName: string, bucketType: BUCKET_TYPES_ENUM): Promise<Buffer<ArrayBufferLike>> {
    try{
      
      const bucketName = this.getBucketByType(bucketType);

      try {
        const fileData = await this.minioClient.statObject(bucketName, fileName);
        this.logger.log(fileData);
      } catch (error) {
        throw new Error(
          `El archivo con ID ${fileName} no existe en el bucket ${bucketName}`,
        );
      }

      const dataStream = await this.minioClient.getObject(bucketName, fileName);

      return new Promise((resolve,reject) => {
        const chunks: any[] = [];
        dataStream.on('data',(chunk) => chunks.push(chunk));
        dataStream.on('end',() => resolve(Buffer.concat(chunks)));
        dataStream.on('error',(error) => reject(error));
      })

    }catch(error){
      throw new Error(`Error obteniendo Bytes de Archivo desde Minio ${error}`)
    }
  }

  private addFileExtension(fileId: string, bucketType: BUCKET_TYPES_ENUM): string {
    switch (bucketType) {
      case BUCKET_TYPES_ENUM.CREATED_DOCUMENTS:
      case BUCKET_TYPES_ENUM.SIGNED_DOCUMENTS:
      case BUCKET_TYPES_ENUM.CANCELLED_DOCUMENTS:
      case BUCKET_TYPES_ENUM.OFICIAL_CARDS:
        return `${fileId}.pdf`;
      case BUCKET_TYPES_ENUM.SIGNATURE_IMAGES:
        return `${fileId}.png`;
      default:
        throw new Error('Tipo de bucket no reconocido');
    }
  }

  private resolveFileData(file:MinioFileI):{buffer:Buffer;mimetype:string}{
    if(Buffer.isBuffer(
      file.file
    )){
      if(!file.mimetype){
        throw new Error('mimetype necesarry cuando se pasa un Buffer');
      }
      return {buffer: file.file, mimetype:file.mimetype}
    }
    return { buffer:file.file.buffer, mimetype: file.file.mimetype}
  }
}
