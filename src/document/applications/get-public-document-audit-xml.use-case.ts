import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { MinioService } from 'src/shared/minio/minio.service';
import { BUCKET_TYPES_ENUM } from 'src/shared/minio/enums/bucket-types.enum';

import { buildDocumentAuditXml } from '../audit-xml/audit-xml.builder';
import { IncompleteAuditEvidenceException } from '../audit-xml/audit-xml.exceptions';
import type {
  AuditXmlDocumentFile,
  AuditXmlSeal,
  AuditXmlSigner,
  AuditXmlSimpleSignature,
} from '../audit-xml/audit-xml.types';
import { DocumentService } from '../document.service';
import { CollaboratorEntity } from '../entities/collaborator.entity';
import { DocumentEntity } from '../entities/document.entity';
import { COLABORATOR_TYPE_ENUM } from '../enum/colaborator-type.enum';
import { DOCUMENT_STATUS_ENUM } from '../enum/document-status.enum';
import { SIGNATURE_TYPE_ENUM } from '../enum/signature-type.enum';
import { SealEntity } from '../seal/entities/seal.entity';
import { SealDocumentUseCase } from '../seal/use-cases/seal-document.use-case';
import { toIsoStringOrNull } from '../utils/iso-date.util';

/** El XML de auditoría listo para responder por HTTP. */
export interface PublicDocumentAuditXml {
  content: Buffer;
  contentType: string;
  fileName: string;
}

/**
 * Tipo MIME de la descarga, sin `charset`.
 *
 * La declaración `<?xml version="1.0" encoding="UTF-8"?>` del propio archivo ya fija la
 * codificación, y RFC 7303 dice que para `application/xml` sin `charset` manda esa declaración.
 * Un parámetro de más aquí sería redundante y contradecirlo sería peor que omitirlo.
 */
const AUDIT_XML_CONTENT_TYPE = 'application/xml';

/**
 * `GET /document/public/:id/audit-xml`: arma en el momento el expediente de auditoría completo del
 * documento —sus tres PDFs, la evidencia del sello y la acreditación de cada firmante— y lo
 * devuelve como un XML descargable.
 *
 * **No persiste nada.** Ni en PostgreSQL ni en MinIO: se lee lo que ya existe, se serializa en
 * memoria y se responde. Dos descargas del mismo documento producen el mismo contenido salvo el
 * `generatedAt` del encabezado; ninguna deja rastro ni modifica documento, firmas, sellos o
 * archivos.
 *
 * Pública como el resto de la vista pública (ver `GetPublicSealArtifactUseCase`): es el mismo
 * material de verificación que ya sirven los botones de esa pantalla, reunido en un solo archivo.
 * Lo que sí es nuevo respecto de esos botones es cuánto se publica —los PDFs completos, la CURP,
 * el IP y la ubicación de cada firmante— sobre una URL que sólo exige conocer el UUID; si eso se
 * quiere restringir, el cambio es quitar `@SkipJwtAuth()` de la ruta, no tocar este caso de uso.
 */
@Injectable()
export class GetPublicDocumentAuditXmlUseCase {
  private readonly logger = new Logger(GetPublicDocumentAuditXmlUseCase.name);

  constructor(
    @InjectRepository(CollaboratorEntity)
    private readonly collaboratorRepository: Repository<CollaboratorEntity>,
    private readonly documentService: DocumentService,
    private readonly minioService: MinioService,
    private readonly sealDocument: SealDocumentUseCase,
  ) {}

  async execute(documentId: string): Promise<PublicDocumentAuditXml> {
    const document = await this.documentService.findOne(documentId);

    // Mismo umbral que el resto de la vista pública: mientras la firma no se completa no hay
    // expediente que auditar, y esta ruta no pide sesión — publicar el PDF original de un
    // documento a medio firmar sería exponerlo a cualquiera que tenga el id.
    if (document.status !== DOCUMENT_STATUS_ENUM.SIGNED) {
      throw new NotFoundException(
        'El documento todavía no se ha completado de firmar',
      );
    }

    const collaborators = await this.findSigners(documentId);

    // El sellado sólo ocurre en documentos de firma avanzada y es best-effort: un documento sin
    // constancia se audita igual, con el nodo del sello marcado como no disponible.
    const seal = await this.sealDocument
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

    const xml = buildDocumentAuditXml({
      generatedAt: new Date().toISOString(),
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

    return {
      content: Buffer.from(xml, 'utf-8'),
      contentType: AUDIT_XML_CONTENT_TYPE,
      fileName: `auditoria-${document.id}.xml`,
    };
  }

  /**
   * Firmantes del documento con todo lo que su nodo necesita en una sola consulta: la cuenta, el
   * usuario de esa cuenta, su información personal (de donde sale la CURP) y su firma de perfil,
   * que respalda a los colaboradores anteriores a que existiera el snapshot de rúbrica.
   *
   * El orden es el de la firma, no el de inserción: el expediente se lee como se firmó.
   */
  private findSigners(documentId: string): Promise<CollaboratorEntity[]> {
    return this.collaboratorRepository.find({
      where: { documentId, colaboratorType: COLABORATOR_TYPE_ENUM.SIGNER },
      relations: {
        account: { user: { personalInformation: true, signature: true } },
      },
      order: { signingOrder: 'ASC', createdAt: 'ASC' },
    });
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
      // Texto UTF-8 tal cual está en la columna: es la preimagen del hash sellado y no se
      // recodifica (ver `audit-xml.builder.ts`).
      canonicalPayload: seal.canonicalPayload ?? null,
      timestampEvidenceBase64: seal.timestampEvidence?.fileBase64 ?? null,
      nom151EvidenceBase64: seal.integrityEvidence?.fileBase64 ?? null,
      nom151CertificatePdfBase64:
        seal.integrityEvidence?.certificatePdfBase64 ?? null,
      sealedAt: toIsoStringOrNull(seal.sealedAt),
    };
  }

  /**
   * Un firmante y su evidencia. Qué se incluye depende del tipo de firma: la avanzada acredita con
   * el certificado del SAT (`advanced_signature` completo), la simple con la rúbrica que estampó.
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
      signedAt: toIsoStringOrNull(collaborator.signedAt),
      signatureType: collaborator.signatureType ?? null,
      status: collaborator.status,
      ipAddress: collaborator.ipAddress ?? null,
      geoLocation: collaborator.geoLoc ?? null,
      advancedSignature: collaborator.advancedSignature
        ? (collaborator.advancedSignature as unknown as Record<string, unknown>)
        : null,
      simpleSignature: isAdvanced
        ? null
        : await this.resolveSimpleSignature(documentId, collaborator),
    };
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
  private async resolveSimpleSignature(
    documentId: string,
    collaborator: CollaboratorEntity,
  ): Promise<AuditXmlSimpleSignature> {
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
