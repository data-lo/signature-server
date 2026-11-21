import { createHash, randomUUID } from 'crypto';

import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { BUCKET_TYPES_ENUM } from 'src/common/minio/enums/bucket-types.enum';
import { MinioService } from 'src/common/minio/minio.service';

import { CollaboratorEntity } from '../../entities/collaborator.entity';
import { DocumentEntity } from '../../entities/document.entity';
import { VerificationCodeEntity } from '../../entities/verification-code.entity';
import { COLABORATOR_TYPE_ENUM } from '../../enum/colaborator-type.enum';
import { VERIFICATION_EVENT_ENUM } from '../../enum/verification-event.enum';
import { SEALING_TYPE_ENUM } from '../enums/sealing-type.enum';
import {
  IncompleteAdvancedSignatureEvidenceException,
  IncompleteSimpleSignatureDataException,
} from '../exceptions/seal.exceptions';
import {
  AdvancedSealingRequestSnapshot,
  FrozenSimpleSignerEvidence,
  SEALING_REQUEST_SNAPSHOT_VERSION,
  SealingRequestSnapshot,
  SealingRequestSnapshotReference,
  SimpleSealingRequestSnapshot,
} from '../interfaces/sealing-request-snapshot.interface';
import { toSealSignature } from '../mappers/advanced-signature-seal.mapper';

/**
 * Único canal por el que hoy se entrega un código de verificación de firma. Mismo valor que
 * `SendCompletedSimpleSignatureToSealUseCase`.
 */
const EMAIL_OTP_VERIFICATION_METHOD = 'EMAIL_OTP';

/** Hashes del documento que el payload simple necesita y que todavía no están en la base al congelar. */
export interface SimpleSnapshotDocumentHashes {
  documentId: string;
  originalHash: string;
  signedHash: string;
}

/**
 * Congela en el bucket privado `sealing-requests` los datos con que se sellará un documento, para
 * que cada reintento del trabajo envíe exactamente lo mismo.
 *
 * - **Firma simple.** El payload actual lee del perfil la identidad del firmante (CURP, nombre), y
 *   el perfil puede cambiar entre un reintento y otro. Se congela al cerrar el documento: identidad,
 *   código de verificación consumido, fecha de firma y referencias inmutables de la rúbrica y de la
 *   INE. No se descarga ninguna imagen: el worker baja los bytes al enviar.
 * - **Firma avanzada.** La firma y el certificado ya están persistidos en el colaborador y no
 *   cambian. Lo único pendiente puede ser la evidencia OCSP, así que el payload se congela después
 *   de completarla (fase `VERIFYING_OCSP` del worker). Nunca hace falta la `.key` ni la contraseña.
 *
 * La tabla de trabajos guarda sólo la referencia (`request_object_key`) y el hash
 * (`request_hash`); ningún dato personal ni imagen se copia a columnas de la base.
 *
 * Ninguna escritura corre dentro de una transacción de Postgres: el snapshot se sube ANTES de abrir
 * la transacción de cierre, y si esa transacción falla el llamador lo descarta con `discard`.
 */
@Injectable()
export class SealingRequestSnapshotService {
  private readonly logger = new Logger(SealingRequestSnapshotService.name);

  constructor(
    @InjectRepository(DocumentEntity)
    private readonly documentRepository: Repository<DocumentEntity>,
    @InjectRepository(CollaboratorEntity)
    private readonly collaboratorRepository: Repository<CollaboratorEntity>,
    @InjectRepository(VerificationCodeEntity)
    private readonly verificationCodeRepository: Repository<VerificationCodeEntity>,
    private readonly minioService: MinioService,
  ) {}

  /**
   * Congela el payload de firma simple de un documento recién completado y lo sube al bucket
   * privado.
   *
   * Los hashes llegan por parámetro porque al cerrar el documento todavía no están en la base: se
   * escriben en la misma transacción que registra el trabajo. Todo lo demás se relee de la base, que
   * ya tiene la firma del último firmante (`resolved_at` lo escribe el claim y el snapshot de su
   * rúbrica se persiste apenas se toma).
   *
   * @param hashes - Documento y sus hashes original y firmado.
   * @returns La referencia del objeto subido y su hash.
   *
   * @throws {IncompleteSimpleSignatureDataException} Si a algún firmante le falta un dato
   *   obligatorio. No se sube nada.
   * @throws {Error} Si MinIO no puede guardar el objeto.
   *
   * @example
   * ```ts
   * const reference = await snapshots.freezeSimpleSignatureRequest({
   *   documentId: document.id,
   *   originalHash: document.originalHash,
   *   signedHash: document.signedHash,
   * });
   * ```
   */
  async freezeSimpleSignatureRequest(
    hashes: SimpleSnapshotDocumentHashes,
  ): Promise<SealingRequestSnapshotReference> {
    const signers = await this.findSimpleSigners(hashes.documentId);
    if (signers.length === 0) {
      throw new IncompleteSimpleSignatureDataException(
        'al menos un firmante',
        hashes.documentId,
      );
    }

    const snapshot: SimpleSealingRequestSnapshot = {
      version: SEALING_REQUEST_SNAPSHOT_VERSION,
      sealType: SEALING_TYPE_ENUM.SIMPLE,
      documentId: hashes.documentId,
      originalHash: hashes.originalHash,
      signedHash: hashes.signedHash,
      frozenAt: new Date().toISOString(),
      signatures: await Promise.all(
        signers.map((signer) =>
          this.freezeSimpleSigner(hashes.documentId, signer),
        ),
      ),
    };

    return this.store(hashes.documentId, snapshot);
  }

  /**
   * Congela el payload de firma avanzada a partir de las firmas persistidas. Lo llama el worker al
   * terminar la fase `VERIFYING_OCSP`.
   *
   * @param documentId - Documento de firma avanzada ya completado.
   * @returns La referencia del objeto subido y su hash.
   *
   * @throws {IncompleteAdvancedSignatureEvidenceException} Si algún firmante no tiene firma avanzada
   *   o le falta la evidencia OCSP. No se sube nada.
   * @throws {Error} Si el documento no existe o MinIO no puede guardar el objeto.
   *
   * @example
   * ```ts
   * const reference = await snapshots.freezeAdvancedSignatureRequest(job.documentId);
   * ```
   */
  async freezeAdvancedSignatureRequest(
    documentId: string,
  ): Promise<SealingRequestSnapshotReference> {
    const document = await this.documentRepository.findOneOrFail({
      where: { id: documentId },
      select: { id: true, originalHash: true },
    });
    const signers = await this.collaboratorRepository.find({
      where: { documentId, colaboratorType: COLABORATOR_TYPE_ENUM.SIGNER },
      order: { signingOrder: 'ASC' },
    });

    for (const signer of signers) {
      if (!signer.advancedSignature) {
        throw new IncompleteAdvancedSignatureEvidenceException(
          'la firma avanzada',
          signer.id,
        );
      }
      if (!signer.advancedSignature.ocspEvidence) {
        throw new IncompleteAdvancedSignatureEvidenceException(
          'la evidencia OCSP',
          signer.id,
        );
      }
    }

    const snapshot: AdvancedSealingRequestSnapshot = {
      version: SEALING_REQUEST_SNAPSHOT_VERSION,
      sealType: SEALING_TYPE_ENUM.ADVANCED,
      documentId,
      frozenAt: new Date().toISOString(),
      request: {
        documentId,
        originalHash: document.originalHash,
        signatures: signers.map((signer) =>
          toSealSignature(signer.advancedSignature!),
        ),
      },
    };

    return this.store(documentId, snapshot);
  }

  /**
   * Lee un snapshot y comprueba que sus bytes sigan teniendo el hash registrado.
   *
   * @param reference - Llave y hash guardados en el trabajo.
   * @returns El payload congelado.
   *
   * @throws {Error} Si el objeto no existe, no es JSON o su hash no coincide.
   *
   * @example
   * ```ts
   * const snapshot = await snapshots.load({ objectKey: job.requestObjectKey!, hash: job.requestHash! });
   * ```
   */
  async load(
    reference: SealingRequestSnapshotReference,
  ): Promise<SealingRequestSnapshot> {
    const content = await this.minioService.getSensitiveObject(
      BUCKET_TYPES_ENUM.SEALING_REQUESTS,
      reference.objectKey,
    );

    if (sha256Hex(content) !== reference.hash) {
      throw new Error(
        'El payload de sellado congelado no coincide con el hash registrado.',
      );
    }

    return JSON.parse(content.toString('utf8')) as SealingRequestSnapshot;
  }

  /**
   * Borra un snapshot que quedó huérfano, por ejemplo porque la transacción de cierre se revirtió o
   * porque el trabajo ya existía con otro payload. Nunca lanza: un objeto sin borrar sólo ocupa
   * espacio, y ningún trabajo lo referencia.
   *
   * @param objectKey - Llave del objeto en `sealing-requests`.
   * @returns Nada.
   *
   * @example
   * ```ts
   * await snapshots.discard(reference.objectKey);
   * ```
   */
  async discard(objectKey: string): Promise<void> {
    try {
      await this.minioService.removeSensitiveObject(
        BUCKET_TYPES_ENUM.SEALING_REQUESTS,
        objectKey,
      );
    } catch (error) {
      this.logger.warn(
        `No se pudo borrar un payload de sellado huérfano: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * Serializa el snapshot, lo sube y calcula su hash sobre los mismos bytes.
   *
   * @param documentId - Documento; prefijo de la llave para ubicar sus snapshots.
   * @param snapshot - Payload que se congela.
   * @returns La referencia del objeto subido.
   *
   * @throws {Error} Si MinIO no puede guardar el objeto.
   *
   * @example
   * ```ts
   * return this.store(documentId, snapshot);
   * ```
   */
  private async store(
    documentId: string,
    snapshot: SealingRequestSnapshot,
  ): Promise<SealingRequestSnapshotReference> {
    const content = Buffer.from(JSON.stringify(snapshot), 'utf8');
    const objectKey = `${documentId}/${randomUUID()}.json`;

    await this.minioService.putSensitiveObject(
      BUCKET_TYPES_ENUM.SEALING_REQUESTS,
      objectKey,
      content,
      'application/json',
    );

    return { objectKey, hash: sha256Hex(content) };
  }

  /**
   * Firmantes del documento con su cuenta, usuario, información personal (incluidas las llaves de
   * la INE, que son `select: false`) y firma de perfil.
   *
   * @param documentId - Documento.
   * @returns Los firmantes, en orden de firma.
   *
   * @example
   * ```ts
   * const signers = await this.findSimpleSigners(documentId);
   * ```
   */
  private findSimpleSigners(documentId: string): Promise<CollaboratorEntity[]> {
    return this.collaboratorRepository
      .createQueryBuilder('collaborator')
      .leftJoinAndSelect('collaborator.account', 'account')
      .leftJoinAndSelect('account.user', 'user')
      .leftJoinAndSelect('user.personalInformation', 'personalInformation')
      .addSelect([
        'personalInformation.frontImageKey',
        'personalInformation.backImageKey',
      ])
      .leftJoinAndSelect('user.signature', 'signature')
      .where('collaborator.document_id = :documentId', { documentId })
      .andWhere('collaborator.colaborator_type = :signerType', {
        signerType: COLABORATOR_TYPE_ENUM.SIGNER,
      })
      .orderBy('collaborator.signing_order', 'ASC')
      .getMany();
  }

  /**
   * Congela la evidencia de un firmante simple con las mismas reglas que el envío actual
   * (`SendCompletedSimpleSignatureToSealUseCase`): identidad de `personal_information` con respaldo
   * en `users`, el código `SIGN_DOCUMENT` consumido más reciente y la rúbrica del snapshot.
   *
   * @param documentId - Documento.
   * @param signer - Firmante con cuenta, usuario e información personal cargados.
   * @returns Su evidencia congelada.
   *
   * @throws {IncompleteSimpleSignatureDataException} Si falta algún dato obligatorio.
   *
   * @example
   * ```ts
   * const evidence = await this.freezeSimpleSigner(documentId, signer);
   * ```
   */
  private async freezeSimpleSigner(
    documentId: string,
    signer: CollaboratorEntity,
  ): Promise<FrozenSimpleSignerEvidence> {
    const user = signer.account?.user;
    if (!user) {
      throw new IncompleteSimpleSignatureDataException(
        'la cuenta de plataforma',
        signer.id,
      );
    }

    const personalInformation = user.personalInformation;
    const curp = personalInformation?.curp || user.nationalId;
    const name = personalInformation?.name || user.firstName;
    const lastName = personalInformation?.lastName || user.lastName;

    const required: [string | null | undefined, string][] = [
      [curp, 'la CURP'],
      [user.email, 'el correo'],
      [name, 'el nombre'],
      [lastName, 'el apellido'],
    ];
    for (const [value, missingData] of required) {
      if (!value) {
        throw new IncompleteSimpleSignatureDataException(
          missingData,
          signer.id,
        );
      }
    }

    if (!signer.resolvedAt) {
      throw new IncompleteSimpleSignatureDataException(
        'la fecha de firma',
        signer.id,
      );
    }

    /**
     * El snapshot inmutable tomado al firmar; la firma en vivo del perfil sólo queda como respaldo
     * para filas anteriores a que existiera el snapshot. Se congela la LLAVE, no el contenido.
     */
    const signatureImageObjectKey =
      signer.signatureSnapshotObjectKey ?? user.signature?.signatureObjectKey;
    if (!signatureImageObjectKey) {
      throw new IncompleteSimpleSignatureDataException(
        'la imagen de firma PNG',
        signer.id,
      );
    }

    if (!personalInformation?.frontImageKey) {
      throw new IncompleteSimpleSignatureDataException(
        'la imagen frontal de la INE verificada',
        signer.id,
      );
    }
    if (!personalInformation.backImageKey) {
      throw new IncompleteSimpleSignatureDataException(
        'la imagen trasera de la INE verificada',
        signer.id,
      );
    }

    return {
      collaboratorId: signer.id,
      curp: curp!,
      email: user.email,
      name: name!,
      lastName: lastName!,
      signedAt: new Date(signer.resolvedAt).toISOString(),
      verificationData: await this.freezeVerificationData(documentId, signer),
      signatureImageObjectKey,
      identityDocumentFrontImageKey: personalInformation.frontImageKey,
      identityDocumentBackImageKey: personalInformation.backImageKey,
    };
  }

  /**
   * Código de un solo uso que el firmante consumió para firmar este documento: el más reciente por
   * `used_at`, mismo criterio que la hoja de evidencia y la vista pública.
   *
   * @param documentId - Documento.
   * @param signer - Firmante.
   * @returns Código, canal y momento de uso.
   *
   * @throws {IncompleteSimpleSignatureDataException} Si no consumió ninguno.
   *
   * @example
   * ```ts
   * const verificationData = await this.freezeVerificationData(documentId, signer);
   * ```
   */
  private async freezeVerificationData(
    documentId: string,
    signer: CollaboratorEntity,
  ): Promise<FrozenSimpleSignerEvidence['verificationData']> {
    const consumedCode = await this.verificationCodeRepository.findOne({
      where: {
        documentId,
        signerId: signer.id,
        event: VERIFICATION_EVENT_ENUM.SIGN_DOCUMENT,
        isUsed: true,
      },
      order: { usedAt: 'DESC' },
    });

    if (!consumedCode?.usedAt) {
      throw new IncompleteSimpleSignatureDataException(
        'el código de verificación consumido',
        signer.id,
      );
    }

    return {
      code: consumedCode.code,
      verificationMethod: EMAIL_OTP_VERIFICATION_METHOD,
      usedAt: new Date(consumedCode.usedAt).toISOString(),
    };
  }
}

/**
 * SHA-256 en hexadecimal.
 *
 * @param content - Bytes.
 * @returns El hash en hexadecimal minúsculo.
 *
 * @example
 * ```ts
 * sha256Hex(Buffer.from('{}')); // '44136fa3…'
 * ```
 */
export function sha256Hex(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}
