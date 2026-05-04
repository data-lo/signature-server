import { Injectable } from '@nestjs/common';
import * as Minio from 'minio';
import { MinioFileI } from './interfaces/minio.file.interface';
import { FILE_STATUS_ENUM } from './enums/file-status-enum';
import { v4 as uuid4 } from 'uuid';
import { GetFileResponse } from './interfaces/minio.get-file-response.interface';
import { BUCKET_TYPES_ENUM } from './enums/bucket-types.enum';

@Injectable()
export class MinioService {
  minioClient: any;

  MINIO_CREATED_DOCUMENTS_BUCKET: any;
  MINIO_SIGNED_DOCUMENTS_BUCKET: any;
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
    this.MINIO_OFICIAL_CARDS_BUCKET = process.env.MINIO_OFICIAL_CARDS_BUCKET;
    this.MINIO_SIGNATURE_IMAGES_BUCKET =
      process.env.MINIO_SIGNATURE_IMAGES_BUCKET;
    this.MINIO_HOST = process.env.MINIO_HOST;
    this.MINIO_PORT = process.env.MINIO_PORT;
    this.MINIO_API = process.env.MINIO_API;
    return;
  }

  private getBucketByType(
    type: 'created_documents' | 'signed_documents' | 'oficial_cards' | 'signature_images',

  ) {
    switch (type) {
      case 'created_documents':
        return this.MINIO_CREATED_DOCUMENTS_BUCKET;
      case 'signed_documents':
        return this.MINIO_SIGNED_DOCUMENTS_BUCKET;
      case 'oficial_cards':
        return this.MINIO_OFICIAL_CARDS_BUCKET;
      case 'signature_images':
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

  async uploadObject(
    file: MinioFileI,
    type:
      | 'created_documents'
      | 'signed_documents'
      | 'oficial_cards'
      | 'signature_images',
  ): Promise<{
    status: FILE_STATUS_ENUM;
    fileId: string;
    bucket: string;
    fileType: string;
  }> {
    try {
      const minioClient = this.getMinioClient();
      const bucketName = this.getBucketByType(type);

      await minioClient.bucketExists(bucketName, (err, exists) => {
        if (err) {
          throw new Error(
            `Error al verificar la existencia del bucket: ${err}`,
          );
        }
      });

      const extension = file.name.split('.').pop()?.toLowerCase();
      const fileName = `${uuid4()}.${extension}`;
      const fileBuffer = file.file.buffer;
      if (!fileBuffer) {
        throw new Error('El archivo no contiene datos válidos');
      }

      await minioClient.putObject(
        bucketName,
        fileName,
        fileBuffer,
        fileBuffer.length,
        { 'Content-Type': file.file.mimetype },
        function (err, etag) {},
      );

      return {
        fileType: file.file.mimetype,
        bucket: bucketName,
        status: FILE_STATUS_ENUM.FILE_CREATED,
        fileId: fileName,
      };
    } catch (error) {
      throw new Error(`Error al subir archivos a MinIO: ${error}`);
    }
  }

  async getFile(
    fileId: string,
    bucketType:BUCKET_TYPES_ENUM,
    expiresIn: number = 24 * 60 * 60,
  ): Promise<GetFileResponse> {
    try {
        
      const minioClient = this.getMinioClient();
      const bucketName = this.getBucketByType(bucketType);
      console.log(bucketName);
      const exists = await minioClient.bucketExists(bucketName);
      
      if(!exists){
        throw new Error(`El bucket ${bucketName} no existe en MinIO`);
      }

      const fileName = this.addFileExtension(fileId, bucketType);
      try{
        console.log(await minioClient.statObject(bucketName, fileName));
      }catch(error){
        throw new Error(`El archivo con ID ${fileId} no existe en el bucket ${bucketName}`);
      }      
      
      const secureUrl = await minioClient.presignedGetObject(bucketName, fileName, expiresIn)

      return {
        fileId,
        secureUrl,
        expiresIn,
      }
    } catch (error) {
      throw new Error(`Error al obtener el archivo de MinIO: ${error}`);
    }
  }



  async replaceFile(
    fileId:string,
    file: MinioFileI,
    type: BUCKET_TYPES_ENUM
  ): Promise<{
    status: FILE_STATUS_ENUM;
    fileId: string;
    bucket: string;
    fileType: string;
  }> {
    try {
      const minioClient = this.getMinioClient();
      const fileName = this.addFileExtension(fileId, type);
      const bucketName = this.getBucketByType(type);
      try{
        const fileData = await minioClient.statObject(bucketName, fileName);
        console.log(fileData);
      }catch(error){
        throw new Error(`El archivo con ID ${fileId} no existe en el bucket ${bucketName}`);
      }
      
      await minioClient.removeObject(bucketName, fileName)
      await minioClient.putObject(
        bucketName,
        fileName,
        file.file.buffer,
        file.file.buffer.length,
        { 'Content-Type': file.file.mimetype },
        function (err, etag) {},
      );

        return {
        fileType: file.file.mimetype,
        bucket: bucketName,
        status: FILE_STATUS_ENUM.FILE_CREATED,
        fileId: fileName,
      };
      
      ;
    } catch(error){
      throw new Error(`Error al reemplazar el archivo en MinIO: ${error}`);
    }
  }

  private addFileExtension(fileId, bucketType){
      switch (bucketType) {
        case 'created_documents':
          return `${fileId}.pdf`;
        case 'signed_documents':
          return `${fileId}.pdf`;
        case 'oficial_cards':
          return `${fileId}.pdf`;
        case 'signature_images':
          return `${fileId}.png`;
        default:
          throw new Error('Tipo de bucket no reconocido');
      }
  }
}
