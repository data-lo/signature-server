import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { MinioService } from 'src/common/minio/minio.service';
import { BUCKET_TYPES_ENUM } from 'src/common/minio/enums/bucket-types.enum';
import { detectImageContentType } from 'src/common/utils/image-content-type.util';

import { DocumentService } from '../document.service';
import { CollaboratorEntity } from '../entities/collaborator.entity';
import { DocumentEntity } from '../entities/document.entity';
import { COLABORATOR_TYPE_ENUM } from '../enum/colaborator-type.enum';
import { DOCUMENT_STATUS_ENUM } from '../enum/document-status.enum';
import { SIGNATURE_TYPE_ENUM } from '../enum/signature-type.enum';
import { SealEntity } from '../seal/entities/seal.entity';
import { SealDocumentUseCase } from '../seal/use-cases/seal-document.use-case';
import { toIsoStringOrNull } from '../utils/iso-date.util';
import { buildDocumentAuditXml } from './audit-xml.builder';
import { IncompleteAuditEvidenceException } from './audit-xml.exceptions';
import type {
  AuditXmlDocumentFile,
  AuditXmlIdentityDocumentImage,
  AuditXmlSeal,
  AuditXmlSigner,
  AuditXmlSimpleSignature,
} from './audit-xml.types';

/** Opciones del armado del XML de auditoría. */
export interface BuildDocumentAuditXmlOptions {
  /**
   * Constancia ya cargada. Si se pasa (también `null`), no se vuelve a consultar; si se omite, se
   * busca por el documento y su ausencia se anota en el XML.
   */
  seal?: SealEntity | null;
}

/**
 * Arma el XML de auditoría de un documento firmado a partir de lo que ya está guardado: sus tres
 * PDFs, la evidencia del sello y la acreditación de cada firmante.
 *
 * Lo usan dos caminos que producen EL MISMO texto:
 * - La descarga pública (`GetPublicDocumentAuditXmlUseCase`).
 * - El registro de verificación (`RecordVerificationRecordDigestUseCase`), que guarda su SHA-256 en
 *   `document_seals.verification_record_digest`.
 *
 * No lleva `generatedAt` ni ningún valor del momento del armado: mientras la evidencia no cambie,
 * el archivo descargado es byte a byte el registro cuya huella se guardó, y así lo reconoce
 * `POST /document/public/verify`.
 *
 * No escribe nada: ni en PostgreSQL ni en MinIO.
 */
@Injectable()
export class DocumentAuditXmlService {
  private readonly logger = new Logger(DocumentAuditXmlService.name);

  constructor(
    @InjectRepository(CollaboratorEntity)
    private readonly collaboratorRepository: Repository<CollaboratorEntity>,
    private readonly documentService: DocumentService,
    private readonly minioService: MinioService,
    private readonly sealDocument: SealDocumentUseCase,
  ) {}

  /**
   * Arma el XML de auditoría de un documento en `SIGNED`.
   *
   * @param documentId - Documento a auditar.
   * @param options - La constancia, si ya se tiene.
   * @returns El texto del XML, en UTF-8.
   *
   * @throws {NotFoundException} Si el documento no existe o todavía no está en `SIGNED`.
   * @throws {IncompleteAuditEvidenceException} Si falta un PDF obligatorio, o una rúbrica o una cara
   *   de la INE registrada no se puede leer.
   *
   * @example
   * ```ts
   * const xml = await auditXml.build(documentId);
   * const record = await auditXml.build(documentId, { seal });
   * ```
   */
  async build(
    documentId: string,
    options: BuildDocumentAuditXmlOptions = {},
  ): Promise<string> {
    const document = await this.documentService.findOne(documentId);

    // Mismo umbral que el resto de la vista pública: mientras la firma no se completa no hay
    // expediente que auditar, y la descarga no pide sesión — publicar el PDF original de un
    // documento a medio firmar sería exponerlo a cualquiera que tenga el id.
    if (document.status !== DOCUMENT_STATUS_ENUM.SIGNED) {
      throw new NotFoundException(
        'El documento todavía no se ha completado de firmar',
      );
    }

    const collaborators = await this.findSigners(documentId);

    // Un documento sin constancia se audita igual, con el nodo del sello marcado como no
    // disponible.
    const seal =
      options.seal !== undefined
        ? options.seal
        : await this.sealDocument
            .findByDocumentId(documentId)
            .catch(() => null);

    const [files, signers] = await Promise.all([
      this.resolveFiles(document),
      Promise.all(
        collaborators.map((collaborator) =>
          this.toAuditSigner(document.id, collaborator),
        ),
      ),
    ]);

    return buildDocumentAuditXml({
      document: {
        id: document.id,
        fileName: document.fileName,
        mimeType: document.fileType,
        status: document.status,
        totalPages: document.totalPages ?? null,
        originalHash: document.originalHash ?? null,
        signedHash: document.signedHash ?? null,
        signedAt: toIsoStringOrNull(document.signedAt),
      },
      files,
      seal: this.toAuditSeal(seal),
      signers,
    });
  }

  /**
   * Firmantes del documento con todo lo que su nodo necesita en una sola consulta: la cuenta, el
   * usuario de esa cuenta, su información personal (de donde salen la CURP y las llaves de la INE)
   * y su firma de perfil, que respalda a los colaboradores anteriores a que existiera el snapshot
   * de rúbrica.
   *
   * Query builder y no `find`: las llaves de la INE son `select: false` en la entidad y sólo
   * viajan si se piden con `addSelect` (mismo patrón que `SendCompletedSimpleSignatureToSealUseCase`).
   *
   * El orden es el de la firma, no el de inserción: el expediente se lee como se firmó. Es un orden
   * total (termina en el id) para que el XML sea reproducible.
   */
  private findSigners(documentId: string): Promise<CollaboratorEntity[]> {
    return (
      this.collaboratorRepository
        .createQueryBuilder('collaborator')
        .leftJoinAndSelect('collaborator.account', 'account')
        .leftJoinAndSelect('account.user', 'user')
        .leftJoinAndSelect('user.personalInformation', 'personalInformation')
        .addSelect([
          'personalInformation.frontImageKey',
          'personalInformation.backImageKey',
        ])
        .leftJoinAndSelect('user.signature', 'signature')
        .where('collaborator.documentId = :documentId', { documentId })
        .andWhere('collaborator.colaboratorType = :signerType', {
          signerType: COLABORATOR_TYPE_ENUM.SIGNER,
        })
        .orderBy('collaborator.signingOrder', 'ASC')
        .addOrderBy('collaborator.createdAt', 'ASC')
        // Desempate final: los colaboradores que se insertan en la misma transacción comparten
        // `created_at` (es el `now()` de la transacción), y sin un orden total dos armados del mismo
        // expediente podrían listar a los firmantes distinto y producir otro digest.
        .addOrderBy('collaborator.id', 'ASC')
        .getMany()
    );
  }

  /**
   * Los tres PDFs del expediente, todos bajo la misma `object_key` del documento en su bucket:
   * el original sin firmar, el firmado (el insumo con el que se calculó `signedHash`) y el
   * definitivo con la hoja de firmas anexada, que es el que se ve en la vista pública.
   *
   * Los dos primeros son obligatorios —sin ellos el archivo no acreditaría qué se firmó ni con qué
   * resultado—; el definitivo se incluye "cuando aplique" y su ausencia sólo se anota.
   */
  private async resolveFiles(
    document: DocumentEntity,
  ): Promise<AuditXmlDocumentFile[]> {
    return Promise.all([
      this.resolveFile(document, {
        role: 'original',
        bucket: BUCKET_TYPES_ENUM.CREATED_DOCUMENTS,
        mimeType: document.fileType,
        required: 'el PDF original sin firmar',
      }),
      this.resolveFile(document, {
        role: 'signed',
        bucket: BUCKET_TYPES_ENUM.SIGNED_DOCUMENTS,
        mimeType: 'application/pdf',
        required: 'el PDF firmado',
      }),
      this.resolveFile(document, {
        role: 'finalized',
        bucket: BUCKET_TYPES_ENUM.FINALIZED_DOCUMENTS,
        mimeType: 'application/pdf',
      }),
    ]);
  }

  private async resolveFile(
    document: DocumentEntity,
    options: {
      role: AuditXmlDocumentFile['role'];
      bucket: BUCKET_TYPES_ENUM;
      mimeType: string;
      /** Cómo nombrar el archivo en el error si es obligatorio. Sin esto, su ausencia se anota. */
      required?: string;
    },
  ): Promise<AuditXmlDocumentFile> {
    const base = {
      role: options.role,
      bucket: options.bucket,
      objectKey: document.objectKey,
      mimeType: options.mimeType,
    };

    try {
      const content = await this.minioService.getFileInBytesFormat(
        document.objectKey,
        options.bucket,
      );

      return { ...base, contentBase64: content.toString('base64') };
    } catch (error) {
      // Sólo el bucket y el motivo: el contenido del archivo nunca se registra.
      this.logger.warn(
        `No se pudo leer ${document.objectKey} de ${options.bucket} para el XML de auditoría del documento ${document.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );

      if (options.required) {
        throw new IncompleteAuditEvidenceException(
          `${options.required} en el bucket ${options.bucket}`,
          document.id,
        );
      }

      return {
        ...base,
        contentBase64: null,
        unavailableReason: `El archivo no está disponible en el bucket ${options.bucket}.`,
      };
    }
  }

  private toAuditSeal(seal: SealEntity | null): AuditXmlSeal | null {
    if (!seal) {
      return null;
    }

    return {
      signatureHash: seal.signatureHash ?? null,
      timestampEvidenceBase64: seal.timestampEvidence?.fileBase64 ?? null,
      nom151EvidenceBase64: seal.integrityEvidence?.fileBase64 ?? null,
      nom151CertificatePdfBase64:
        seal.integrityEvidence?.certificatePdfBase64 ?? null,
      sealedAt: toIsoStringOrNull(seal.sealedAt),
    };
  }

  /**
   * Un firmante y su evidencia. Qué se incluye depende del tipo de firma: la avanzada acredita con
   * el certificado del SAT (`advanced_signature` completo), la simple con la rúbrica que estampó y
   * la INE que verificó Didit.
   *
   * `!== FIEL` y no `=== SIMPLE`: `signature_type` es nullable y las filas anteriores a que
   * existiera la firma avanzada lo tienen en NULL siendo firma simple. Es el mismo criterio con el
   * que `DocumentService.sign` decide por qué rama firmar.
   */
  private async toAuditSigner(
    documentId: string,
    collaborator: CollaboratorEntity,
  ): Promise<AuditXmlSigner> {
    const user = collaborator.account?.user;
    const isAdvanced = collaborator.signatureType === SIGNATURE_TYPE_ENUM.FIEL;

    return {
      id: collaborator.id,
      // El correo de la cuenta vinculada manda; el de la fila de colaborador es el de la
      // invitación y sólo existe mientras esa cuenta no se ha vinculado.
      email: user?.email ?? collaborator.email ?? null,
      // La CURP canónica vive en `personal_information`; `users.national_id` es la copia del
      // registro y sólo respalda a las filas donde la canónica falta (mismo criterio que el envío
      // de firmas simples a Seal Service).
      curp: user?.personalInformation?.curp ?? user?.nationalId ?? null,
      signedAt: toIsoStringOrNull(collaborator.resolvedAt),
      signatureType: collaborator.signatureType ?? null,
      status: collaborator.status,
      ipAddress: collaborator.ipAddress ?? null,
      geoLocation: collaborator.geolocation ?? null,
      advancedSignature: collaborator.advancedSignature
        ? (collaborator.advancedSignature as unknown as Record<string, unknown>)
        : null,
      simpleSignature: isAdvanced
        ? null
        : await this.resolveSimpleSignature(documentId, collaborator),
    };
  }

  /**
   * Evidencia completa de un firmante de firma simple: la rúbrica y las dos caras de la INE.
   *
   * @param documentId - Documento auditado, para el error.
   * @param collaborator - Firmante con `account.user.personalInformation` (y sus llaves de INE) cargado.
   * @returns La rúbrica y las imágenes de la INE, listas para el nodo `signatureMedia`.
   *
   * @throws {IncompleteAuditEvidenceException} Si alguna imagen registrada no se puede leer o no es
   *   una imagen.
   *
   * @example
   * ```ts
   * const evidence = await this.resolveSimpleSignature(document.id, collaborator);
   * evidence.identityDocumentFrontImage.mimeType; // 'image/jpeg'
   * ```
   */
  private async resolveSimpleSignature(
    documentId: string,
    collaborator: CollaboratorEntity,
  ): Promise<AuditXmlSimpleSignature> {
    const [
      signatureImage,
      identityDocumentFrontImage,
      identityDocumentBackImage,
    ] = await Promise.all([
      this.resolveSignatureImage(documentId, collaborator),
      this.resolveIdentityDocumentImage(documentId, collaborator, 'front'),
      this.resolveIdentityDocumentImage(documentId, collaborator, 'back'),
    ]);

    return {
      ...signatureImage,
      identityDocumentFrontImage,
      identityDocumentBackImage,
    };
  }

  /**
   * Una cara de la INE del firmante, leída del bucket privado `identity-documents` donde la dejó el
   * webhook de Didit, en Base64 y con su tipo MIME detectado por los bytes.
   *
   * Se lee de MinIO y no de Didit: las URLs de media del proveedor vencen a las pocas horas, y la
   * copia guardada es exactamente la que se verificó.
   *
   * Mismo criterio que la rúbrica: si Didit no entregó esa cara (no hay llave) se anota como no
   * disponible y la descarga sigue; si la llave existe y el objeto no se puede leer o no es una
   * imagen, la evidencia está rota y se responde con error. Ni la llave ni el contenido se registran
   * en el log.
   *
   * @param documentId - Documento auditado, para el error.
   * @param collaborator - Firmante con `account.user.personalInformation` y sus llaves cargadas.
   * @param side - `front` para el anverso, `back` para el reverso.
   * @returns La imagen en Base64 con su `mimeType`, o la imagen marcada como no disponible.
   *
   * @throws {IncompleteAuditEvidenceException} Si el objeto registrado no se puede leer de MinIO o
   *   no es JPEG, PNG ni WebP.
   *
   * @example
   * ```ts
   * const front = await this.resolveIdentityDocumentImage(document.id, collaborator, 'front');
   * // { mimeType: 'image/jpeg', contentBase64: '/9j/4AAQ...' }
   * ```
   */
  private async resolveIdentityDocumentImage(
    documentId: string,
    collaborator: CollaboratorEntity,
    side: 'front' | 'back',
  ): Promise<AuditXmlIdentityDocumentImage> {
    const personalInformation = collaborator.account?.user?.personalInformation;
    const objectKey =
      side === 'front'
        ? personalInformation?.frontImageKey
        : personalInformation?.backImageKey;
    const sideLabel = side === 'front' ? 'frontal' : 'trasera';

    if (!objectKey) {
      return {
        mimeType: null,
        contentBase64: null,
        unavailableReason: `El firmante no tiene la imagen ${sideLabel} de la INE verificada por Didit.`,
      };
    }

    let image: Buffer;

    try {
      image = await this.minioService.getSensitiveObject(
        BUCKET_TYPES_ENUM.IDENTITY_DOCUMENTS,
        objectKey,
      );
    } catch (error) {
      // `getSensitiveObject` ya omite la llave de su mensaje; aquí tampoco se registra.
      this.logger.warn(
        `No se pudo leer la imagen ${sideLabel} de la INE del colaborador ${collaborator.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );

      throw new IncompleteAuditEvidenceException(
        `la imagen ${sideLabel} de la INE del firmante ${collaborator.id}`,
        documentId,
      );
    }

    try {
      const mimeType = detectImageContentType(image);

      if (!mimeType) {
        throw new IncompleteAuditEvidenceException(
          `una imagen ${sideLabel} de la INE válida del firmante ${collaborator.id}`,
          documentId,
        );
      }

      return { mimeType, contentBase64: image.toString('base64') };
    } finally {
      // Los bytes de la INE no sobreviven a su conversión; el Base64 vive sólo durante la respuesta.
      image.fill(0);
    }
  }

  /**
   * Rúbrica PNG del firmante, en Base64.
   *
   * Se prefiere `signature_snapshot_object_key` —la copia inmutable tomada en el instante de
   * firmar— sobre la firma vigente del perfil: si el usuario la reemplazó después, la evidencia
   * tiene que ser la que realmente se estampó en el PDF. La del perfil queda como respaldo para
   * las filas anteriores a que existiera el snapshot.
   *
   * Un firmante sin ninguna llave se anota como rúbrica no registrada y no rompe la descarga: hay
   * documentos anteriores a que se guardara. Pero si la llave existe y el objeto no se puede leer,
   * eso sí es evidencia rota y se responde con error — un expediente que omitiera la rúbrica de un
   * firmante sin decirlo estaría afirmando algo falso.
   */
  private async resolveSignatureImage(
    documentId: string,
    collaborator: CollaboratorEntity,
  ): Promise<
    Pick<
      AuditXmlSimpleSignature,
      'objectKey' | 'imageBase64' | 'unavailableReason'
    >
  > {
    const objectKey =
      collaborator.signatureSnapshotObjectKey ??
      collaborator.account?.user?.signature?.signatureObjectKey ??
      null;

    if (!objectKey) {
      return {
        objectKey: null,
        imageBase64: null,
        unavailableReason: 'El firmante no tiene una rúbrica registrada.',
      };
    }

    try {
      const image = await this.minioService.getFileInBytesFormat(
        objectKey,
        BUCKET_TYPES_ENUM.SIGNATURE_IMAGES,
      );

      return { objectKey, imageBase64: image.toString('base64') };
    } catch (error) {
      this.logger.warn(
        `No se pudo leer la rúbrica ${objectKey} del colaborador ${collaborator.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );

      throw new IncompleteAuditEvidenceException(
        `la imagen de firma del firmante ${collaborator.id}`,
        documentId,
      );
    }
  }
}
