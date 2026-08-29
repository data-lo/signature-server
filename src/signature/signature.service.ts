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
  async assertOwnership(
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
  assertWithinSizeLimit(
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
  async deleteFileIfExists(
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

    /**
     * Se rechaza el alta sólo si el usuario tiene una firma CON IMAGEN, no por el mero hecho de
     * apuntar a una fila.
     *
     * Bug corregido: `deleteSignatureImage` borra la fila —y con ella `users.signature_id`—
     * únicamente cuando la INE también está vacía (ver `clearFieldOrDeleteRow`); si el usuario
     * tenía INE, la fila sobrevive con `signature_object_key` en null y el usuario sigue
     * apuntándole. Este guard leía sólo `signatureId`, así que confundía esa fila sin imagen con
     * una firma vigente: quien borraba su firma y volvía a dibujarla recibía "ya tiene una firma
     * registrada" y quedaba bloqueado de forma permanente, sin manera de salir desde la app.
     */
    const existingSignature = user.signatureId
      ? await this.signatureRepository.findOne({
          where: { id: user.signatureId },
        })
      : null;

    if (existingSignature?.signatureObjectKey) {
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

    /**
     * Sobre la fila que sobrevivió al borrado se ESCRIBE, no se inserta otra: el usuario ya
     * apunta a ella y su INE sigue ahí. Insertar una segunda dejaría la anterior huérfana con la
     * identificación oficial dentro.
     *
     * `officialCardObjectKey` se conserva salvo que esta alta traiga una INE nueva, que es lo
     * único que puede legítimamente reemplazarla.
     */
    const saved = existingSignature
      ? await this.signatureRepository.save({
          ...existingSignature,
          signatureObjectKey: signatureObjectKeyResponse.fileId,
          officialCardObjectKey:
            officialCardObjectKeyResponse?.fileId ??
            existingSignature.officialCardObjectKey,
          isActive: true,
        })
      : await this.signatureRepository.save(
          this.signatureRepository.create({
            signatureObjectKey: signatureObjectKeyResponse.fileId,
            officialCardObjectKey:
              officialCardObjectKeyResponse?.fileId ?? null,
            isActive: true,
          }),
        );

    // Sólo cuando la fila es nueva: al reusar la existente el usuario ya la referencia.
    if (!existingSignature) {
      await this.userRepository.update(userId, { signatureId: saved.id });
    }

    return {
      success: true,
      message: 'Firma registrada correctamente',
      data: {
        id: saved.id,
      },
    };
  }

  /** Marca la firma como activa o inactiva. */
  async setActive(id: string, isActive: boolean): Promise<void> {
    await this.signatureRepository.update({ id }, { isActive });
  }

  /**
   * Deja un archivo en su bucket y se asegura de que la fila apunte a él.
   *
   * Si ya había un object key se reemplaza el contenido en su lugar, en vez de subir uno nuevo
   * y actualizar la referencia: así no queda el archivo anterior huérfano en MinIO, y las URLs
   * que ya circulen siguen resolviendo al archivo correcto.
   */
  async replaceOrUploadFile(
    signatureId: string,
    existingObjectKey: string | null,
    file: Express.Multer.File,
    bucketType: BUCKET_TYPES_ENUM,
    field: 'signatureObjectKey' | 'officialCardObjectKey',
  ): Promise<void> {
    if (existingObjectKey) {
      await this.minioService.replaceFile(
        existingObjectKey,
        { file, name: file.originalname },
        bucketType,
      );
      return;
    }

    const uploadResponse = await this.minioService.uploadObject(
      { file, name: file.originalname },
      bucketType,
    );

    await this.signatureRepository.update(
      { id: signatureId },
      { [field]: uploadResponse.fileId },
    );
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
  async clearFieldOrDeleteRow(
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

  /**
   * Sobrescribe el PNG de la firma con una imagen transparente del mismo tamaño.
   *
   * Se reemplaza el contenido en lugar de borrar el objeto porque los documentos ya firmados
   * siguen apuntando a ese object key: borrarlo dejaría esas firmas sin imagen. Una imagen
   * transparente conserva la referencia y a la vez deja de mostrar el trazo.
   */
  async blankOutSignatureImage(objectKey: string): Promise<void> {
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
      objectKey,
      { file: blankPngBuffer, name: 'blank.png', mimetype: 'image/png' },
      BUCKET_TYPES_ENUM.SIGNATURE_IMAGES,
    );
  }

  async getFile(fileId: string, bucketType: BUCKET_TYPES_ENUM) {
    return await this.minioService.getFile(fileId, bucketType);
  }
}
