/* eslint-disable prettier/prettier */
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
  ) {}

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
   * Verifica que la firma pertenezca al usuario autenticado consultando
   * el FK signatureId del lado de User (dueño real de la relación).
   */
  private async assertOwnership(
    signatureId: string,
    currentUserId: string,
  ): Promise<void> {
    const user = await this.userRepository.findOne({
      where: { id: currentUserId },
    });
    if (!user || user.signatureId !== signatureId) {
      throw new ForbiddenException(
        'La firma no pertenece al usuario autenticado',
      );
    }
  }

  /**
   * Elimina un objeto de Minio de forma idempotente: si el archivo ya no existe
   * (por ejemplo, un intento de borrado previo que falló a mitad de camino),
   * no lanza error para permitir que el registro en BD se termine de limpiar.
   * Cualquier otro error (Minio inalcanzable, permisos, etc.) sí se propaga.
   */
  private async deleteFileIfExists(
    objectKey: string,
    bucketType: BUCKET_TYPES_ENUM,
    errorMessage: string,
  ): Promise<void> {
    try {
      await this.minioService.deleteFile(objectKey, bucketType);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('no existe en el bucket')) {
        this.logger.warn(
          `El archivo ${objectKey} ya no existía en Minio; se continúa con la limpieza en BD.`,
        );
        return;
      }
      throw new InternalServerErrorException(errorMessage);
    }
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
    files: {
      signatureImage?: Express.Multer.File[];
      officialFile?: Express.Multer.File[];
    },
  ): Promise<BaseResponse<{ id: string }>> {
    const user = await this.userRepository.findOne({
      where: { id: userId },
    });
    if (!user) {
      throw new NotFoundException(`Usuario con id ${userId} no encontrado`);
    }

    if (user.signatureId) {
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
      throw new InternalServerErrorException(
        'Error al subir la imagen de firma a nuestros servidores',
      );
    }

    if (officialCardObjectKeyResponse?.status !== 'FILE_CREATED') {
      throw new InternalServerErrorException(
        'Error al subir la imagen de identificación oficial a nuestros servidores',
      );
    }

    const newSignature = this.signatureRepository.create({
      signatureObjectKey: signatureObjectKeyResponse.fileId,
      officialCardObjectKey: officialCardObjectKeyResponse.fileId,
      isActive: true,
    });

    const saved = await this.signatureRepository.save(newSignature);

    await this.userRepository.update(userId, { signatureId: saved.id });

    return {
      success: true,
      message: 'Firma registrada correctamente',
      data: {
        id: saved.id,
      },
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

    await this.assertOwnership(id, currentUserId);

    let message = 'Firma actualizada correctamente';

    if (!signature.isActive) {
      await this.signatureRepository.update({ id }, { isActive: true });

      message = 'Firma activa y actualizada correctamente';
    }

    if (files.signatureImage) {
      let objectKey = signature.signatureObjectKey;

      if (objectKey) {
        await this.minioService.replaceFile(
          objectKey,
          {
            file: files.signatureImage,
            name: files.signatureImage.fieldname,
          },
          BUCKET_TYPES_ENUM.SIGNATURE_IMAGES,
        );
      } else {
        const uploadResponse = await this.minioService.uploadObject(
          {
            file: files.signatureImage,
            name: files.signatureImage.originalname,
          },
          BUCKET_TYPES_ENUM.SIGNATURE_IMAGES,
        );
        objectKey = uploadResponse.fileId;
        await this.signatureRepository.update(
          { id },
          { signatureObjectKey: objectKey },
        );
      }
    }

    if (files.officialFile) {
      let objectKey = signature.officialCardObjectKey;

      if (objectKey) {
        await this.minioService.replaceFile(
          objectKey,
          {
            file: files.officialFile,
            name: files.officialFile.filename,
          },
          BUCKET_TYPES_ENUM.OFICIAL_CARDS,
        );
      } else {
        const uploadResponse = await this.minioService.uploadObject(
          { file: files.officialFile, name: files.officialFile.originalname },
          BUCKET_TYPES_ENUM.OFICIAL_CARDS,
        );
        objectKey = uploadResponse.fileId;
        await this.signatureRepository.update(
          { id },
          { officialCardObjectKey: objectKey },
        );
      }
    }

    return {
      success: true,
      message: message,
      data: { id: signature.id },
    };
  }

  /**
   * Elimina la imagen de firma del usuario (Minio + BD).
   * Si la identificación oficial también estaba vacía, elimina el registro completo
   * para permitir un registro nuevo desde cero.
   */
  async deleteSignatureImage(
    id: string,
    currentUserId: string,
  ): Promise<BaseResponse<null>> {
    const signature = await this.findOne(id);

    await this.assertOwnership(id, currentUserId);

    if (!signature.signatureObjectKey) {
      throw new BadRequestException(
        'No hay una imagen de firma registrada para eliminar',
      );
    }

    await this.deleteFileIfExists(
      signature.signatureObjectKey,
      BUCKET_TYPES_ENUM.SIGNATURE_IMAGES,
      'Error al eliminar la imagen de firma en el almacenamiento',
    );

    if (!signature.officialCardObjectKey) {
      await this.signatureRepository.delete({ id });
      await this.userRepository.update(currentUserId, { signatureId: null });
    } else {
      await this.signatureRepository.update(
        { id },
        { signatureObjectKey: null },
      );
    }

    return {
      success: true,
      message: 'Imagen de firma eliminada correctamente',
      data: null,
    };
  }

  /**
   * Elimina la identificación oficial (INE) del usuario (Minio + BD).
   * Si la imagen de firma también estaba vacía, elimina el registro completo
   * para permitir un registro nuevo desde cero.
   */
  async deleteOfficialFile(
    id: string,
    currentUserId: string,
  ): Promise<BaseResponse<null>> {
    const signature = await this.findOne(id);

    await this.assertOwnership(id, currentUserId);

    if (!signature.officialCardObjectKey) {
      throw new BadRequestException(
        'No hay una identificación oficial registrada para eliminar',
      );
    }

    await this.deleteFileIfExists(
      signature.officialCardObjectKey,
      BUCKET_TYPES_ENUM.OFICIAL_CARDS,
      'Error al eliminar la identificación oficial en el almacenamiento',
    );

    if (!signature.signatureObjectKey) {
      await this.signatureRepository.delete({ id });
      await this.userRepository.update(currentUserId, { signatureId: null });
    } else {
      await this.signatureRepository.update(
        { id },
        { officialCardObjectKey: null },
      );
    }

    return {
      success: true,
      message: 'Identificación oficial eliminada correctamente',
      data: null,
    };
  }

  async deactivate(id: string, currentUserId: string): Promise<BaseResponse> {
    const signature = await this.signatureRepository.findOne({ where: { id } });

    if (!signature) {
      throw new NotFoundException(`Firma con ID ${id} no encontrada`);
    }

    await this.assertOwnership(id, currentUserId);

    if (!signature.isActive) {
      throw new BadRequestException(
        `La firma con ID ${id} ya está desactivada`,
      );
    }

    const blankPngBuffer = await sharp({
      create: {
        width: 100,
        height: 100,
        channels: 4,
        background: { r: 255, g: 255, b: 255, alpha: 0 },
      },
    })
      .png()
      .toBuffer();

    await this.minioService.replaceFile(
      signature.signatureObjectKey,
      {
        file: blankPngBuffer,
        name: 'blank.png',
        mimetype: 'image/png',
      },
      BUCKET_TYPES_ENUM.SIGNATURE_IMAGES,
    );

    signature.isActive = false;

    await this.signatureRepository.save(signature);

    const minio = await this.minioService.getFile(
      signature.signatureObjectKey,
      BUCKET_TYPES_ENUM.SIGNATURE_IMAGES,
    );

    return {
      success: true,
      message: 'Firma desactivada correctamente',
      data: {
        id: signature.id,
        secureUrl: minio.secureUrl,
        expiresIn: minio.expiresIn,
      },
    };
  }

  async getFile(fileId: string, bucketType: BUCKET_TYPES_ENUM) {
    return await this.minioService.getFile(fileId, bucketType);
  }
}
