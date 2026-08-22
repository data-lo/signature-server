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
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { SignatureEntity } from './entities/signature.entity';
import { UserEntity } from 'src/user/entities/user.entity';
import { CreateSignatureDto } from './dto/create-signature.dto';
import { MinioService } from 'src/shared/minio/minio.service';
import 'multer';
import { BUCKET_TYPES_ENUM } from 'src/shared/minio/enums/bucket-types.enum';
import { BaseResponse } from 'src/interfaces/api-response.dto';
import {
  MAX_IMAGE_FILE_SIZE_BYTES,
  MAX_PDF_FILE_SIZE_BYTES,
} from 'src/shared/constants/file-upload.constants';
import sharp = require('sharp');
import { SIGNING_CREDENTIAL_STATUS_ENUM } from 'src/user/enums/signing-credential-status.enum';
import { UpdateSigningCredentialStatusUseCase } from 'src/identity-verification/applications/update-signing-credential-status.use-case';

@Injectable()
export class SignatureService {
  logger = new Logger(SignatureService.name);

  constructor(
    @InjectRepository(SignatureEntity)
    private readonly signatureRepository: Repository<SignatureEntity>,
    @InjectRepository(UserEntity)
    private readonly userRepository: Repository<UserEntity>,
    private readonly minioService: MinioService,
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly updateSigningCredentialStatus: UpdateSigningCredentialStatusUseCase,
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
   * El `limits.fileSize` de multer en el controller ya rechaza cualquier archivo por encima de
   * `MAX_UPLOAD_SAFETY_NET_BYTES` (25MB) antes de que llegue aquí — ese es solo un techo de
   * seguridad. Este check aplica el límite real de negocio, más estricto y específico por tipo
   * de archivo, con un mensaje claro en español en vez del error genérico de multer.
   */
  private assertWithinSizeLimit(
    file: Express.Multer.File,
    maxBytes: number,
    label: string,
  ): void {
    if (file.size > maxBytes) {
      throw new BadRequestException(
        `${label} debe pesar menos de ${Math.floor(maxBytes / (1024 * 1024))}MB`,
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
      this.assertWithinSizeLimit(
        signatureFile,
        MAX_IMAGE_FILE_SIZE_BYTES,
        'La imagen de firma',
      );
    }
    if (officialFile) {
      this.assertWithinSizeLimit(
        officialFile,
        MAX_PDF_FILE_SIZE_BYTES,
        'La identificación oficial',
      );
    }

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

    if (
      officialFile &&
      officialCardObjectKeyResponse?.status !== 'FILE_CREATED'
    ) {
      throw new InternalServerErrorException(
        'Error al subir la imagen de identificación oficial a nuestros servidores',
      );
    }

    const newSignature = this.signatureRepository.create({
      signatureObjectKey: signatureObjectKeyResponse.fileId,
      officialCardObjectKey: officialCardObjectKeyResponse?.fileId ?? null,
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

    if (files.signatureImage) {
      this.assertWithinSizeLimit(
        files.signatureImage,
        MAX_IMAGE_FILE_SIZE_BYTES,
        'La imagen de firma',
      );
    }
    if (files.officialFile) {
      this.assertWithinSizeLimit(
        files.officialFile,
        MAX_PDF_FILE_SIZE_BYTES,
        'La identificación oficial',
      );
    }

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
            name: files.signatureImage.originalname,
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
            name: files.officialFile.originalname,
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

    if (files.signatureImage) {
      /**
       * Reponer la firma PNG por esta vía también completa la credencial: el usuario que la
       * borró quedó en SIGNATURE_PENDING y sin esto seguiría ahí pese a tener firma otra vez.
       * `applyIfAllowed` mantiene el resto de los casos como no-op (ya CONFIGURED, o identidad
       * no aprobada).
       */
      await this.updateSigningCredentialStatus.applyIfAllowed(
        currentUserId,
        SIGNING_CREDENTIAL_STATUS_ENUM.CONFIGURED,
      );
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

    await this.clearFieldOrDeleteRow(id, currentUserId, 'signatureObjectKey');

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

    await this.clearFieldOrDeleteRow(
      id,
      currentUserId,
      'officialCardObjectKey',
    );

    return {
      success: true,
      message: 'Identificación oficial eliminada correctamente',
      data: null,
    };
  }

  /**
   * Bug corregido: `deleteSignatureImage`/`deleteOfficialFile` cada uno leía `signature` por su
   * cuenta al inicio del método y decidía "¿el OTRO campo también está vacío?" contra esa
   * lectura. Si ambos se ejecutaban casi al mismo tiempo (dos pestañas, doble clic en cada
   * botón), ambas lecturas veían todavía el otro campo presente → ambos tomaban la rama
   * "solo limpiar mi campo" → los dos archivos quedaban borrados de MinIO pero NINGUNA
   * limpiaba `user.signatureId`, dejando una fila `signatures` "vacía" a la que el usuario
   * seguía apuntando — `create()` la rechaza para siempre con "ya tienes una firma registrada",
   * sin intervención manual en BD.
   *
   * El lock pesimista (`SELECT ... FOR UPDATE`) serializa las dos llamadas sobre la misma fila:
   * la segunda transacción espera a que la primera confirme, y entonces lee el estado YA
   * actualizado por la primera — así que la decisión "¿limpiar solo mi campo, o borrar toda la
   * fila?" siempre se toma sobre datos frescos, nunca sobre una lectura obsoleta.
   */
  private async clearFieldOrDeleteRow(
    id: string,
    currentUserId: string,
    clearedField: 'signatureObjectKey' | 'officialCardObjectKey',
  ): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const locked = await manager.findOne(SignatureEntity, {
        where: { id },
        lock: { mode: 'pessimistic_write' },
      });
      if (!locked) return;

      const otherField =
        clearedField === 'signatureObjectKey'
          ? 'officialCardObjectKey'
          : 'signatureObjectKey';

      if (!locked[otherField]) {
        // Bug independiente encontrado de paso: `users.signature_id` tiene una FK
        // `ON DELETE NO ACTION` hacia `signatures.id` (ver InitialSchema) — hay que limpiar la
        // referencia en `users` ANTES de borrar la fila de `signatures`, o Postgres rechaza el
        // delete por violar la constraint. El orden anterior (borrar primero) nunca funcionaba
        // en este código, en carrera o no.
        await manager.update(UserEntity, currentUserId, { signatureId: null });
        await manager.delete(SignatureEntity, { id });
      } else {
        await manager.update(SignatureEntity, { id }, { [clearedField]: null });
      }
    });
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
