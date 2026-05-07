import {
  BadRequestException,
  Injectable,
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

@Injectable()
export class SignatureService {
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
   * Crea una nueva firma para un usuario existente.
   * Sube la imagen de firma a Minio y guarda el object key resultante en la entidad.
   * Al finalizar, actualiza el signatureId del usuario con el UUID de la firma creada.
   * La imagen de INE queda pendiente hasta que se llame al método update.
   */

  async create(
    dto: CreateSignatureDto,
    files: Array<Express.Multer.File>,
  ): Promise<SignatureEntity> {
    const user = await this.userRepository.findOne({
      where: { id: dto.userId },
    });
    if (!user) {
      throw new NotFoundException(`Usuario con id ${dto.userId} no encontrado`);
    }

    let signatureObjectKeyResponse = null;
    let officialCardObjectKeyResponse = null;

    const { signatureFile, oficialCardPdfFile } =
      this.minioService.checkSignatureFileObjects(files);

    if (signatureFile) {
      signatureObjectKeyResponse = await this.minioService.uploadObject(
        { file: signatureFile, name: signatureFile.originalname },
        'signature_images',
      );
    }

    if (oficialCardPdfFile) {
      officialCardObjectKeyResponse = await this.minioService.uploadObject(
        { file: oficialCardPdfFile, name: oficialCardPdfFile.originalname },
        'oficial_cards',
      );
    }

    if (signatureObjectKeyResponse.status !== 'FILE_CREATED') {
      throw new Error('Error al subir la imagen de firma a Minio');
    }

    if (officialCardObjectKeyResponse.status !== 'FILE_CREATED') {
      throw new Error(
        'Error al subir la imagen de identificación oficial a Minio',
      );
    }

    const signature = this.signatureRepository.create({
      signatureObjectKey: signatureObjectKeyResponse.fileId,
      officialCardObjectKey: officialCardObjectKeyResponse.fileId,
      createdBy: dto.createdBy ?? null,
      isActive: true,
      userId: dto.userId,
    });

    const saved = await this.signatureRepository.save(signature);

    // Asignar el UUID de la firma creada al usuario correspondiente
    await this.userRepository.update(dto.userId, { signatureId: saved.id });

    return saved;
  }

  /**
   * Actualiza la imagen de firma y/o la imagen de INE de una firma existente.
   * Cada archivo es opcional: solo se actualizan los campos cuyos archivos se envíen.
   * Sube los nuevos archivos a Minio y actualiza los object keys en la entidad.
   */
  async update(
    id: string,
    files: {
      imagen_firma?: Express.Multer.File;
      imagen_ine?: Express.Multer.File;
    },
  ): Promise<SignatureEntity> {
    const signatureData = await this.findOne(id);

    if (!signatureData) {
      throw new NotFoundException(`Firma con id ${id} no encontrada`);
    }

    if (files.imagen_firma) {
      await this.minioService.replaceFile(
        signatureData.signatureObjectKey,
        {
          file: files.imagen_firma,
          name: files.imagen_firma.fieldname,
        },
        BUCKET_TYPES_ENUM.SIGNATURE_IMAGES,
      );
    }

    if(files.imagen_ine){
      await this.minioService.replaceFile(
        signatureData.officialCardObjectKey,
        {
          file: files.imagen_ine,
          name: files.imagen_ine.filename
        },
        BUCKET_TYPES_ENUM.OFICIAL_CARDS
      )
    }

    return await this.findOne(id);
  }

  /**
   * Desactiva una firma: sobreescribe la imagen de firma en Minio con un PNG en blanco
   * y establece isActive en false. La imagen de INE (officialCardObjectKey) se conserva intacta.
   */
  async deactivate(id: string): Promise<SignatureEntity> {
    const signature = await this.findOne(id);

    // TODO: sobreescribir la imagen de firma en Minio con un PNG en blanco cuando MinioService esté implementado
    // await this.minioService.overwrite(signature.signatureObjectKey, BLANK_PNG_BUFFER); // subir el blank_png a minio

    signature.isActive = false;
    return this.signatureRepository.save(signature);
  }

  async getFile(fileId: string, bucketType:BUCKET_TYPES_ENUM){
    return await this.minioService.getFile(fileId, bucketType);
  }
}
