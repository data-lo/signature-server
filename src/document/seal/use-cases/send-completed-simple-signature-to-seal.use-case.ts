import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { QueryFailedError, Repository } from 'typeorm';
import { MinioService } from 'src/common/minio/minio.service';
import { BUCKET_TYPES_ENUM } from 'src/common/minio/enums/bucket-types.enum';
import { detectImageContentType } from 'src/common/utils/image-content-type.util';
import {
  SimpleSignatureDTO,
  SimpleSignerSignature,
} from '../dto/simple-signature.dto';
import {
  IncompleteSimpleSignatureDataException,
  SealPersistenceException,
} from '../exceptions/seal.exceptions';
import { SealApiService } from '../services/seal-api.service';
import { SealEntity } from '../entities/seal.entity';
import { SealMapper } from '../mappers/seal.mapper';
import { SealDocumentResponse } from '../interfaces/seal-document-response.interface';
import {
  FrozenSimpleSignerEvidence,
  SimpleSealingRequestSnapshot,
} from '../interfaces/sealing-request-snapshot.interface';

/**
 * Firma de archivo PNG (89 50 4E 47 0D 0A 1A 0A). Se compara contra los primeros bytes del objeto
 * descargado y no contra su extensión o el mimetype con el que se subió: el nombre lo eligió
 * quien subió el archivo, los bytes no.
 */
const PNG_MAGIC_NUMBER = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

/** Código de Postgres de una violación de unicidad. */
const UNIQUE_VIOLATION = '23505';

/**
 * Sella en Seal Service un documento de FIRMA SIMPLE a partir de su payload congelado y guarda la
 * constancia. Es la fase `GENERATING_SEAL` de `ProcessDocumentSealingJobUseCase` para el contrato
 * `SIMPLE`.
 *
 * Es el hermano de `SealDocumentUseCase`, que hace lo propio para la firma avanzada: en la avanzada
 * la evidencia es criptográfica —el certificado del SAT prueba quién firmó—, mientras que en la
 * simple la prueba de identidad son estos datos (quién es la persona, con qué código de un solo uso
 * se acreditó, qué rúbrica estampó y su INE verificada).
 *
 * **Del snapshot, no del perfil.** La identidad, el código y las fechas se congelaron al cerrar el
 * documento (`SealingRequestSnapshotService.freezeSimpleSignatureRequest`); aquí sólo se descargan
 * los bytes de la rúbrica y la INE por las llaves inmutables que se congelaron. Si el usuario
 * cambia su perfil entre un intento y otro, cada reintento sigue mandando exactamente lo mismo, y
 * Seal Service reconoce el envío por su clave idempotente.
 */
@Injectable()
export class SendCompletedSimpleSignatureToSealUseCase {
  private readonly logger = new Logger(
    SendCompletedSimpleSignatureToSealUseCase.name,
  );

  constructor(
    @InjectRepository(SealEntity)
    private readonly sealRepository: Repository<SealEntity>,
    private readonly minioService: MinioService,
    private readonly sealApiService: SealApiService,
  ) {}

  /**
   * Arma el envío desde el snapshot, lo manda a Seal Service y guarda la constancia.
   *
   * El envío es idempotente por documento (`Idempotency-Key: signature-server:document:<id>:v1`):
   * si el guardado local falla después de la emisión, el siguiente intento recibe la evidencia ya
   * emitida en vez de pedir otra constancia al PSC.
   *
   * @param snapshot - Payload congelado de firma simple.
   * @returns La constancia guardada, o la que ya existía si otro intento la guardó primero.
   *
   * @throws {IncompleteSimpleSignatureDataException} Si una imagen congelada ya no es válida (la
   *   rúbrica no es PNG o la INE no es imagen). Se lanza ANTES de llamar al proveedor.
   * @throws {SealPersistenceException} Si la constancia no se pudo guardar por otra causa que un
   *   duplicado; repetir recupera la misma evidencia.
   * @throws {Error} Si MinIO no entrega una imagen, o los errores tipados de `SealApiService`.
   *
   * @example
   * ```ts
   * const seal = await sendSimpleSignatures.execute(snapshot);
   * ```
   */
  async execute(snapshot: SimpleSealingRequestSnapshot): Promise<SealEntity> {
    const dto: SimpleSignatureDTO = {
      documentId: snapshot.documentId,
      originalHash: snapshot.originalHash,
      signedHash: snapshot.signedHash,
      signatures: [],
    };

    let response: SealDocumentResponse;
    try {
      for (const signer of snapshot.signatures) {
        dto.signatures.push(await this.toSignerSignature(signer));
      }
      response = await this.sealApiService.sendSimpleSignatures(dto);
    } finally {
      // Las imágenes de la INE no se conservan más allá del envío, salga bien o mal.
      this.releaseIdentityDocumentImages(dto);
    }

    // Sólo el documento y el número de firmantes: nada del contenido del DTO.
    this.logger.log(
      `Firmas simples del documento ${dto.documentId} selladas en Seal Service (${dto.signatures.length} firmante(s)).`,
    );

    return this.persistSeal(dto.documentId, response);
  }

  /**
   * Guarda la constancia con el MISMO mapper que la avanzada: la respuesta tiene idéntica forma.
   *
   * Sólo una violación de unicidad de `document_seals.document_id` se trata como duplicado: otro
   * intento guardó la constancia primero, y se relee. Cualquier otro error (base caída, columna
   * inválida) se propaga: tragarlo y releer devolvería `null` y el trabajo avanzaría sin constancia.
   *
   * @param documentId - Documento.
   * @param response - Respuesta de Seal Service.
   * @returns La constancia guardada o la existente.
   *
   * @throws {SealPersistenceException} Si no se pudo guardar por otra causa, o si el duplicado no
   *   se encuentra al releer.
   *
   * @example
   * ```ts
   * return this.persistSeal(documentId, response);
   * ```
   */
  private async persistSeal(
    documentId: string,
    response: SealDocumentResponse,
  ): Promise<SealEntity> {
    try {
      return await this.sealRepository.save(
        this.sealRepository.create(
          SealMapper.toEntity({ documentId }, response),
        ),
      );
    } catch (error) {
      if (isUniqueViolation(error)) {
        const existing = await this.sealRepository.findOneBy({ documentId });
        if (existing) {
          this.logger.warn(
            `El documento ${documentId} ya tenía constancia; se conserva la existente.`,
          );
          return existing;
        }
      }

      this.logger.error(
        `No se pudo guardar la constancia del documento ${documentId}.`,
        error instanceof Error ? error.stack : undefined,
      );
      throw new SealPersistenceException();
    }
  }

  /**
   * Traduce la evidencia congelada de un firmante al contrato de Seal Service, descargando la
   * rúbrica y la INE por sus llaves.
   *
   * @param signer - Evidencia congelada.
   * @returns La firma lista para enviar.
   *
   * @throws {IncompleteSimpleSignatureDataException} Si una imagen no es válida.
   * @throws {Error} Si MinIO no puede entregarla.
   *
   * @example
   * ```ts
   * const signature = await this.toSignerSignature(snapshot.signatures[0]);
   * ```
   */
  private async toSignerSignature(
    signer: FrozenSimpleSignerEvidence,
  ): Promise<SimpleSignerSignature> {
    return {
      curp: signer.curp,
      email: signer.email,
      name: signer.name,
      lastName: signer.lastName,
      signedAt: signer.signedAt,
      verificationData: { ...signer.verificationData },
      signatureMedia: {
        signatureImage: await this.readSignatureImage(signer),
        identityDocumentFrontImage: await this.readIdentityDocumentImage(
          signer.identityDocumentFrontImageKey,
          'frontal',
          signer.collaboratorId,
        ),
        identityDocumentBackImage: await this.readIdentityDocumentImage(
          signer.identityDocumentBackImageKey,
          'trasera',
          signer.collaboratorId,
        ),
      },
    };
  }

  /**
   * Descarga la rúbrica congelada (el snapshot inmutable que se estampó) y la devuelve en Base64.
   *
   * @param signer - Evidencia congelada.
   * @returns La rúbrica en Base64.
   *
   * @throws {IncompleteSimpleSignatureDataException} Si lo almacenado no es un PNG.
   * @throws {Error} Si MinIO no puede entregarla.
   *
   * @example
   * ```ts
   * const image = await this.readSignatureImage(signer);
   * ```
   */
  private async readSignatureImage(
    signer: FrozenSimpleSignerEvidence,
  ): Promise<string> {
    const image = await this.minioService.getFileInBytesFormat(
      signer.signatureImageObjectKey,
      BUCKET_TYPES_ENUM.SIGNATURE_IMAGES,
    );

    if (!isPng(image)) {
      throw new IncompleteSimpleSignatureDataException(
        'una imagen de firma en formato PNG (el archivo almacenado no lo es)',
        signer.collaboratorId,
      );
    }

    // Base64 y no bytes crudos: el cuerpo del envío es JSON. Ver `SimpleSignatureMedia`.
    return image.toString('base64');
  }

  /**
   * Lee una cara de la INE del bucket privado, comprueba que sea una imagen y la convierte a Base64
   * en memoria, borrando los bytes en cuanto ya no hacen falta. Nunca se manda una URL.
   *
   * @param objectKey - Llave interna del objeto en `identity-documents`.
   * @param side - Cara de la INE, para el mensaje de error.
   * @param collaboratorId - Firmante, para el mensaje de error.
   * @returns La imagen en Base64, sin prefijo.
   *
   * @throws {IncompleteSimpleSignatureDataException} Si lo almacenado no es JPEG, PNG ni WebP.
   * @throws {Error} Si MinIO no puede entregar el archivo.
   *
   * @example
   * ```ts
   * const front = await this.readIdentityDocumentImage(key, 'frontal', signer.collaboratorId);
   * ```
   */
  private async readIdentityDocumentImage(
    objectKey: string,
    side: 'frontal' | 'trasera',
    collaboratorId: string,
  ): Promise<string> {
    const image = await this.minioService.getSensitiveObject(
      BUCKET_TYPES_ENUM.IDENTITY_DOCUMENTS,
      objectKey,
    );

    try {
      if (!detectImageContentType(image)) {
        throw new IncompleteSimpleSignatureDataException(
          `una imagen ${side} de INE válida (el archivo almacenado no es una imagen)`,
          collaboratorId,
        );
      }

      return image.toString('base64');
    } finally {
      image.fill(0);
    }
  }

  /**
   * Suelta las imágenes de la INE del DTO una vez enviado, para que no sobrevivan en memoria más
   * allá de la petición a Seal Service.
   *
   * @param dto - DTO ya enviado (o cuyo envío falló).
   * @returns Nada; deja vacíos los campos de la INE.
   *
   * @example
   * ```ts
   * this.releaseIdentityDocumentImages(dto);
   * ```
   */
  private releaseIdentityDocumentImages(dto: SimpleSignatureDTO): void {
    for (const signature of dto.signatures) {
      signature.signatureMedia.identityDocumentFrontImage = '';
      signature.signatureMedia.identityDocumentBackImage = '';
    }
  }
}

/**
 * Indica si los bytes empiezan con la firma de un PNG.
 *
 * @param image - Bytes descargados.
 * @returns `true` si es PNG.
 *
 * @example
 * ```ts
 * isPng(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00])); // true
 * ```
 */
function isPng(image: Buffer): boolean {
  return (
    image.length > PNG_MAGIC_NUMBER.length &&
    image.subarray(0, PNG_MAGIC_NUMBER.length).equals(PNG_MAGIC_NUMBER)
  );
}

/**
 * Indica si un error de TypeORM es una violación de unicidad de Postgres.
 *
 * @param error - Error del guardado.
 * @returns `true` sólo para `23505`.
 *
 * @example
 * ```ts
 * if (isUniqueViolation(error)) { … }
 * ```
 */
export function isUniqueViolation(error: unknown): boolean {
  if (!(error instanceof QueryFailedError)) {
    return false;
  }
  const driverError = error.driverError as { code?: string } | undefined;
  return driverError?.code === UNIQUE_VIOLATION;
}
