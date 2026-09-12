import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { UserEntity } from 'src/user/entities/user.entity';
import { PersonalInformationEntity } from 'src/user/entities/personal-information.entity';
import { MinioService } from 'src/common/minio/minio.service';
import { BUCKET_TYPES_ENUM } from 'src/common/minio/enums/bucket-types.enum';
import { extractIdentityDocumentImageUrls } from '../didit/didit-identity-images';
import {
  DiditMediaDownloaderService,
  type DownloadedIdentityImage,
} from '../didit/didit-media-downloader.service';
import { IdentityDocumentImagesProcessingException } from '../exceptions/identity-verification.exceptions';

export interface StoreVerifiedIdentityImagesInput {
  /** Usuario cuya identidad aprobó Didit. */
  userId: string;
  /** Intento local (`identity_verifications.id`) que se aprobó. */
  verificationId: string;
  /** `decision` del webhook de Didit, con las URLs de las imágenes. */
  decision: Record<string, unknown> | null;
}

/**
 * Guarda en el bucket privado las imágenes frontal y trasera de la INE que Didit verificó, y deja
 * sus llaves en `personal_information`.
 *
 * @remarks
 * Flujo:
 *
 * 1. Resuelve la información personal del usuario.
 * 2. Si ya tiene las dos llaves de ESTE intento, termina: es un reintento del webhook.
 * 3. Extrae del veredicto las URLs de las dos imágenes; si falta alguna, falla.
 * 4. Descarga y valida ambas (host, protocolo, tipo, tamaño y bytes mágicos).
 * 5. Las sube a `identity-documents` y, sólo con las DOS guardadas, actualiza las llaves.
 *
 * **Llaves deterministas por intento**: `{personalInformationId}/{verificationId}/front.jpg`. Dos
 * UUID y nada del titular. Un reintento que falló a medias sobrescribe los mismos objetos en vez
 * de dejar huérfanos, y un intento YA guardado no se vuelve a descargar ni a sobrescribir. Un
 * intento NUEVO (el usuario volvió a verificarse) escribe bajo su propio prefijo y sólo entonces
 * pasa a ser la INE vigente.
 *
 * **No registra URLs, llaves, contenido ni datos del titular**: sólo el id del intento. Los bytes
 * descargados se borran de memoria en cuanto se suben.
 */
@Injectable()
export class StoreVerifiedIdentityImagesUseCase {
  private readonly logger = new Logger(StoreVerifiedIdentityImagesUseCase.name);

  constructor(
    @InjectRepository(UserEntity)
    private readonly userRepository: Repository<UserEntity>,
    @InjectRepository(PersonalInformationEntity)
    private readonly personalInformationRepository: Repository<PersonalInformationEntity>,
    private readonly mediaDownloader: DiditMediaDownloaderService,
    private readonly minioService: MinioService,
  ) {}

  /**
   * Descarga, guarda y enlaza las imágenes de la INE de una identidad aprobada.
   *
   * @param input - Usuario, intento aprobado y veredicto de Didit.
   * @returns Nada; si regresa, las dos llaves de este intento quedaron guardadas.
   *
   * @throws {IdentityDocumentImagesProcessingException} Si el usuario no tiene información personal,
   *   el veredicto no trae las dos imágenes, alguna no se puede descargar o validar, o no se pueden
   *   guardar en MinIO. No deja llaves a medias: sin las dos guardadas no se actualiza nada.
   *
   * @example
   * ```ts
   * await storeVerifiedIdentityImages.execute({ userId, verificationId: attempt.id, decision });
   * ```
   */
  async execute(input: StoreVerifiedIdentityImagesInput): Promise<void> {
    const personalInformation = await this.findPersonalInformation(
      input.userId,
    );
    const keyPrefix = `${personalInformation.id}/${input.verificationId}/`;

    if (
      personalInformation.frontImageKey?.startsWith(keyPrefix) &&
      personalInformation.backImageKey?.startsWith(keyPrefix)
    ) {
      this.logger.log(
        `Las imágenes de la INE de la verificación ${input.verificationId} ya estaban guardadas; no se vuelven a descargar.`,
      );
      return;
    }

    const urls = extractIdentityDocumentImageUrls(input.decision);

    if (!urls.front || !urls.back) {
      throw new IdentityDocumentImagesProcessingException(
        'el veredicto aprobado no incluye las imágenes frontal y trasera de la INE',
      );
    }

    const [front, back] = await this.downloadBoth(urls.front, urls.back);
    const frontImageKey = `${keyPrefix}front.${front.extension}`;
    const backImageKey = `${keyPrefix}back.${back.extension}`;

    try {
      await this.minioService.putSensitiveObject(
        BUCKET_TYPES_ENUM.IDENTITY_DOCUMENTS,
        frontImageKey,
        front.content,
        front.contentType,
      );
      await this.minioService.putSensitiveObject(
        BUCKET_TYPES_ENUM.IDENTITY_DOCUMENTS,
        backImageKey,
        back.content,
        back.contentType,
      );
    } catch (error) {
      throw new IdentityDocumentImagesProcessingException(
        `no se pudieron guardar en el almacenamiento privado (${
          error instanceof Error ? error.message : 'error desconocido'
        })`,
      );
    } finally {
      front.content.fill(0);
      back.content.fill(0);
    }

    await this.personalInformationRepository.update(personalInformation.id, {
      frontImageKey,
      backImageKey,
    });

    this.logger.log(
      `Imágenes de la INE de la verificación ${input.verificationId} guardadas en el almacenamiento privado.`,
    );
  }

  /**
   * Información personal del usuario con sus llaves actuales, que no se cargan por defecto.
   *
   * @param userId - Usuario aprobado.
   * @returns La fila con `id`, `frontImageKey` y `backImageKey`.
   *
   * @throws {IdentityDocumentImagesProcessingException} Si el usuario o su información personal no existen.
   *
   * @example
   * ```ts
   * const personalInformation = await this.findPersonalInformation('user-1');
   * ```
   */
  private async findPersonalInformation(
    userId: string,
  ): Promise<PersonalInformationEntity> {
    const user = await this.userRepository.findOne({
      where: { id: userId },
      select: { id: true, personalInformationId: true },
    });

    const personalInformation = user?.personalInformationId
      ? await this.personalInformationRepository.findOne({
          where: { id: user.personalInformationId },
          select: { id: true, frontImageKey: true, backImageKey: true },
        })
      : null;

    if (!personalInformation) {
      throw new IdentityDocumentImagesProcessingException(
        'el usuario no tiene información personal registrada',
      );
    }

    return personalInformation;
  }

  /**
   * Descarga las dos caras en paralelo; si una falla, borra la otra antes de propagar el error.
   *
   * @param frontUrl - URL de la cara frontal.
   * @param backUrl - URL de la cara trasera.
   * @returns Las dos imágenes validadas, en orden frontal y trasera.
   *
   * @throws {IdentityDocumentImagesProcessingException} El primer fallo de descarga o validación.
   *
   * @example
   * ```ts
   * const [front, back] = await this.downloadBoth(urls.front, urls.back);
   * ```
   */
  private async downloadBoth(
    frontUrl: string,
    backUrl: string,
  ): Promise<[DownloadedIdentityImage, DownloadedIdentityImage]> {
    const [front, back] = await Promise.allSettled([
      this.mediaDownloader.download(frontUrl, 'frontal'),
      this.mediaDownloader.download(backUrl, 'trasera'),
    ]);

    if (front.status === 'fulfilled' && back.status === 'fulfilled') {
      return [front.value, back.value];
    }

    [front, back].forEach((result) => {
      if (result.status === 'fulfilled') {
        result.value.content.fill(0);
      }
    });

    throw front.status === 'rejected'
      ? front.reason
      : (back as PromiseRejectedResult).reason;
  }
}
