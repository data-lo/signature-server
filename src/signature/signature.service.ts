import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { SignatureEntity } from './entities/signature.entity';
import { UserEntity } from 'src/user/entities/user.entity';
import { CreateSignatureDto } from './dto/create-signature.dto';
import { MinioService } from 'src/shared/minio/minio.service';
import 'multer';
import { BUCKET_TYPES_ENUM } from 'src/shared/minio/enums/bucket-types.enum';
import { BaseResponse } from 'src/interfaces/api-response.dto';
import sharp = require('sharp');

@Injectable()
export class SignatureService {
  logger = new Logger(SignatureService.name);

  constructor(
    @InjectRepository(SignatureEntity)
    private readonly signatureRepository: Repository<SignatureEntity>,
    @InjectRepository(UserEntity)
    private readonly userRepository: Repository<UserEntity>,
    private readonly minioService: MinioService,
  ) { }

  /**
   * Obtiene una firma por su UUID.
   * Lanza NotFoundException si no existe.
   */
  async findOne(id: string): Promise<SignatureEntity> {
    const signature = await this.signatureRepository.findOne({ where: { id } });
    if (!signature) {
      throw new NotFoundException(`Firma con id ${id} no encontrada`);
    }
    return signature;
  }

  /**
   * Crea una nueva firma para el usuario autenticado.
   * Sube la imagen de firma a Minio y guarda el object key resultante en la entidad.
   * Al finalizar, actualiza el signatureId del usuario con el UUID de la firma creada.
   * La imagen de INE queda pendiente hasta que se llame al método update.
   */

  async create(
    userId: string,
    dto: CreateSignatureDto,
    files: { signatureImage?: Express.Multer.File[]; officialFile?: Express.Multer.File[] },
  ): Promise<BaseResponse<{ id: string }>> {
    const user = await this.userRepository.findOne({
      where: { id: userId },
    });
    if (!user) {
      throw new NotFoundException(`Usuario con id ${userId} no encontrado`);
    }

    const signature = await this.signatureRepository.findOne({
      where: {
        userId: user.id
      }
    })

    if (signature) {
      throw new ConflictException('El usuario ya tiene una firma registrada');
    }

    let signatureObjectKeyResponse = null;
    let officialCardObjectKeyResponse = null;

    const signatureFile = files?.signatureImage?.[0];
    const officialFile = files?.officialFile?.[0];

    if (signatureFile) {
      signatureObjectKeyResponse = await this.minioService.uploadObject(
        { file: signatureFile, name: signatureFile.originalname },
        BUCKET_TYPES_ENUM.SIGNATURE_IMAGES,
      );
    }

    if (officialFile) {
      officialCardObjectKeyResponse = await this.minioService.uploadObject(
        { file: officialFile, name: officialFile.originalname },
        BUCKET_TYPES_ENUM.OFICIAL_CARDS,
      );
    }

    if (signatureObjectKeyResponse?.status !== 'FILE_CREATED') {
      throw new InternalServerErrorException('Error al subir la imagen de firma a nuestros servidores');
    }

    if (officialCardObjectKeyResponse?.status !== 'FILE_CREATED') {
      throw new InternalServerErrorException('Error al subir la imagen de identificación oficial a nuestros servidores');
    }

    const newSignature = this.signatureRepository.create({
      signatureObjectKey: signatureObjectKeyResponse.fileId,
      officialCardObjectKey: officialCardObjectKeyResponse.fileId,
      createdBy: userId,
      isActive: true,
      userId,
    });

    const saved = await this.signatureRepository.save(newSignature);

    await this.userRepository.update(userId, { signatureId: saved.id });

    return {
      success: true,
      message: 'Firma registrada correctamente',
      data: {
        id: saved.id
      }
    };
  }

  /**
   * Actualiza la imagen de firma y/o la imagen de INE de una firma existente.
   * Cada archivo es opcional: solo se actualizan los campos cuyos archivos se envíen.
   * Sube los nuevos archivos a Minio y actualiza los object keys en la entidad.
   */
  async update(
    id: string,
    currentUserId: string,
    files: {
      signatureImage?: Express.Multer.File;
      officialFile?: Express.Multer.File;
    },
  ): Promise<BaseResponse<{ id: string }>> {
    const signature = await this.findOne(id);

    if (!signature) {
      throw new NotFoundException(`Firma con id ${id} no encontrada`);
    }

    if (signature.userId !== currentUserId) {
      throw new ForbiddenException('La firma no pertenece al usuario autenticado');
    }

    let message = "Firma actualizada correctamente"

    if (!signature.isActive) {
      await this.signatureRepository.update(
        { id },
        { isActive: true }
      );

      message = "Firma activa y actualizada correctamente"
    }

    if (files.signatureImage) {
      await this.minioService.replaceFile(
        signature.signatureObjectKey,
        {
          file: files.signatureImage,
          name: files.signatureImage.fieldname,
        },
        BUCKET_TYPES_ENUM.SIGNATURE_IMAGES,
      );
    }

    if (files.officialFile) {
      await this.minioService.replaceFile(
        signature.officialCardObjectKey,
        {
          file: files.officialFile,
          name: files.officialFile.filename
        },
        BUCKET_TYPES_ENUM.OFICIAL_CARDS,
      );
    }

    return {
      success: true,
      message: message,
      data: { id: signature.id }
    };
  }

  async deactivate(id: string, currentUserId: string): Promise<BaseResponse> {

    const signature = await this.signatureRepository.findOne({ where: { id } });

    if (!signature) {
      throw new NotFoundException(`Firma con ID ${id} no encontrada`);
    }

    if (signature.userId !== currentUserId) {
      throw new ForbiddenException('La firma no pertenece al usuario autenticado');
    }

    if (!signature.isActive) {
      throw new BadRequestException(`La firma con ID ${id} ya está desactivada`);
    }

    const blankPngBuffer = await sharp({
      create: {
        width: 100,
        height: 100,
        channels: 4,
        background: { r: 255, g: 255, b: 255, alpha: 0 }
      }
    }).png().toBuffer();

    await this.minioService.replaceFile(
      signature.signatureObjectKey,
      {
        file: blankPngBuffer,
        name: 'blank.png',
        mimetype: 'image/png'
      },
      BUCKET_TYPES_ENUM.SIGNATURE_IMAGES
    );

    signature.isActive = false;

    await this.signatureRepository.save(signature);

    const minio = await this.minioService.getFile(signature.signatureObjectKey, BUCKET_TYPES_ENUM.SIGNATURE_IMAGES)

    return {
      success: true,
      message: 'Firma desactivada correctamente',
      data: {
        id: signature.id,
        secureUrl: minio.secureUrl,
        expiresIn: minio.expiresIn
      }
    };
  }

  async getFile(fileId: string, bucketType: BUCKET_TYPES_ENUM) {
    return await this.minioService.getFile(fileId, bucketType);
  }
}
