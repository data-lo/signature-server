import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { SignatureEntity } from './entities/signature.entity';
import { UserEntity } from 'src/user/entities/user.entity';
import { CreateSignatureDto } from './dto/create-signature.dto';
import { MinioService } from 'src/shared/minio/minio.service';
import 'multer';

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
    signatureFile: Express.Multer.File,
  ): Promise<SignatureEntity> {
    if (!signatureFile) {
      throw new BadRequestException('La imagen de firma (imagen_firma) es requerida');
    }

    const user = await this.userRepository.findOne({ where: { id: dto.userId } });
    if (!user) {
      throw new NotFoundException(`Usuario con id ${dto.userId} no encontrado`);
    }

    // TODO: subir imagen a Minio cuando MinioService esté implementado
    // const signatureObjectKey = await this.minioService.upload(signatureFile, 'signatures');
    const signatureObjectKey = `signatures/${dto.userId}/${Date.now()}.png`;

    const signature = this.signatureRepository.create({
      signatureObjectKey,
      officialCardObjectKey: null,
      createdBy: dto.createdBy ?? null,
      isActive: true,
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
      imagen_firma?: Express.Multer.File[];
      imagen_ine?: Express.Multer.File[];
    },
  ): Promise<SignatureEntity> {
    const signature = await this.findOne(id);

    if (files.imagen_firma?.[0]) {
      // TODO: subir imagen de firma a Minio cuando MinioService esté implementado
      // signature.signatureObjectKey = await this.minioService.upload(files.imagen_firma[0], 'signatures');
      signature.signatureObjectKey = `signatures/${id}/${Date.now()}.png`;
    }

    if (files.imagen_ine?.[0]) {
      // TODO: subir imagen de INE a Minio cuando MinioService esté implementado
      // signature.officialCardObjectKey = await this.minioService.upload(files.imagen_ine[0], 'official-cards');
      signature.officialCardObjectKey = `official-cards/${id}/${Date.now()}.png`;
    }

    return this.signatureRepository.save(signature);
  }

  /**
   * Desactiva una firma: sobreescribe la imagen de firma en Minio con un PNG en blanco
   * y establece isActive en false. La imagen de INE (officialCardObjectKey) se conserva intacta.
   */
  async deactivate(id: string): Promise<SignatureEntity> {
    const signature = await this.findOne(id);

    // TODO: sobreescribir la imagen de firma en Minio con un PNG en blanco cuando MinioService esté implementado
    // await this.minioService.overwrite(signature.signatureObjectKey, BLANK_PNG_BUFFER);

    signature.isActive = false;
    return this.signatureRepository.save(signature);
  }
}
