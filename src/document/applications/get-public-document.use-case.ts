import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { MinioService } from 'src/shared/minio/minio.service';
import { BUCKET_TYPES_ENUM } from 'src/shared/minio/enums/bucket-types.enum';
import { UserService } from 'src/user/user.service';

import { CollaboratorEntity } from '../entities/collaborator.entity';
import { COLABORATOR_TYPE_ENUM } from '../enum/colaborator-type.enum';
import { DOCUMENT_STATUS_ENUM } from '../enum/document-status.enum';
import { DocumentEntity } from '../entities/document.entity';
import { DocumentPublicViewResponse } from '../interfaces/responses/document-public-view-response';
import { toConservationRecord } from '../summary-document/conservation-record.util';
import { toIsoStringOrNull } from '../utils/iso-date.util';
import { SealDocumentUseCase } from '../seal/use-cases/seal-document.use-case';
import { RetryPendingSealUseCase } from '../seal/use-cases/retry-pending-seal.use-case';
import { SealEntity } from '../seal/entities/seal.entity';
import { extractTsaCertificateInfo } from '../seal/utils/tsa-certificate.util';
import { DocumentService } from '../document.service';

/** Serie y fecha de emisión (`notBefore`) del certificado TSA embebido en la evidencia NOM-151. */
interface PublicIntegrityTsaCertificate {
  serialNumber: string;
  issuedAt: string;
}

@Injectable()
export class GetPublicDocumentUseCase {
  constructor(
    @InjectRepository(CollaboratorEntity)
    private readonly collaboratorRepository: Repository<CollaboratorEntity>,
    private readonly minioService: MinioService,
    private readonly userService: UserService,
    private readonly sealDocumentUseCase: SealDocumentUseCase,
    private readonly documentService: DocumentService,
    private readonly retryPendingSeal: RetryPendingSealUseCase,
  ) {}

  private readonly logger = new Logger(GetPublicDocumentUseCase.name);

  /**
   * Devuelve la vista pública de un documento, sin autenticación.
   *
   * El gate por `status === SIGNED` ocurre ANTES de siquiera considerar Minio: como cualquiera con
   * el UUID puede llamar esta ruta, si el documento no está firmado no se resuelve el bucket ni se
   * llama a `minioService.getFile` —lo único que genera la URL prefirmada—, así que nunca se expone
   * el archivo de un documento pendiente, rechazado, cancelado o expirado.
   *
   * Las rutas autenticadas resuelven la URL para cualquier estatus vía `STATUS_BUCKET_MAP`, porque
   * allí ya hubo un control de acceso previo.
   */
  async execute(documentId: string): Promise<DocumentPublicViewResponse> {
    const document = await this.documentService.findOne(documentId);

    const signerCollaborators = await this.collaboratorRepository.find({
      where: {
        documentId,
        colaboratorType: COLABORATOR_TYPE_ENUM.SIGNER,
      },
      relations: { account: { user: true } },
      order: { signingOrder: 'ASC', createdAt: 'ASC' },
    });

    // Un documento a medio firmar no expone NADA más que su nombre y quiénes deben firmarlo (ver
    // historia "Actualizar vista pública de verificación de documentos según estado y tipo de
    // firma"). No es solo diseño: mientras la firma no se completa no hay evidencia que constatar,
    // y publicar el estatus individual convertiría esta URL —que no pide sesión— en un tablero de
    // quién ya firmó y quién no para cualquiera que tenga el id.
    if (document.status !== DOCUMENT_STATUS_ENUM.SIGNED) {
      return {
        success: true,
        message: 'Documento obtenido correctamente',
        data: {
          id: document.id,
          fileName: document.fileName,
          status: document.status,
          isCompleted: false,
          secureUrl: null,
          expiresIn: null,
          hash: null,
          totalPages: null,
          createdBy: null,
          // Un documento sin completar no espera constancia: todavía no hay nada que sellar.
          sealingPending: false,
          conservationRecord: null,
          signers: signerCollaborators.map((collaborator) =>
            this.documentService.toPendingPublicSigner(collaborator),
          ),
          downloads: { nom151: false, timestamp: false, canonical: false },
          sealEvidence: {
            timestampFileBase64: null,
            integrityFileBase64: null,
          },
          integrityTsaCertificate: null,
        },
      };
    }

    // Versión definitiva (documento + hoja de firmas): es la única que se comparte hacia afuera.
    const { secureUrl, expiresIn } = await this.minioService.getFile(
      document.objectKey,
      BUCKET_TYPES_ENUM.FINALIZED_DOCUMENTS,
    );

    /**
     * Reintento perezoso del sellado pendiente: si el documento se firmó mientras el SAT estaba
     * caído, esta visita es la oportunidad de completar la evidencia y sellarlo. Se hace ANTES de
     * leer el sello para que la misma respuesta ya incluya la constancia recién emitida, en vez
     * de mostrarla como pendiente una visita más.
     *
     * Best-effort y silencioso: si el SAT sigue sin responder, el documento se muestra igual con
     * su marca de pendiente. Ninguna consulta pública puede fallar por esto.
     */
    await this.completePendingSealIfDue(document, signerCollaborators);

    // Solo se sellan los documentos con firma AVANZADA (ver `sealAdvancedSignatures`) y el sellado
    // es best-effort: un documento de firma simple, o uno cuyo sellado falló, se completa sin
    // constancia. La vista pública tiene que poder mostrarse igual en ese caso.
    const seal = await this.sealDocumentUseCase
      .findByDocumentId(document.id)
      .catch(() => null);

    const creator = await this.userService
      .findOne(document.createdBy)
      .catch(() => null);

    const signers = await Promise.all(
      signerCollaborators.map((collaborator) =>
        this.documentService.toCompletedPublicSigner(document.id, collaborator),
      ),
    );

    const conservationRecord = toConservationRecord(seal);
    const integrityTsaCertificate =
      await this.resolveIntegrityTsaCertificate(seal);

    return {
      success: true,
      message: 'Documento obtenido correctamente',
      data: {
        id: document.id,
        fileName: document.fileName,
        status: document.status,
        isCompleted: true,
        secureUrl,
        expiresIn,
        hash: document.signedHash ?? document.originalHash,
        totalPages: document.totalPages,
        // El mismo dato que imprime la hoja de evidencia anexada al PDF, para que la pantalla y el
        // documento no digan cosas distintas sobre quién lo creó.
        createdBy: creator?.email ?? null,
        /**
         * `true` mientras el documento espera su constancia porque el SAT no respondió al firmar.
         * La vista lo dice en vez de mostrar la sección vacía sin explicación: el documento está
         * firmado y es válido, sólo le falta la constancia — y va a llegar.
         */
        sealingPending: document.sealingPendingAt !== null,
        conservationRecord: conservationRecord
          ? {
              tsaCertificate: conservationRecord.tsaCertificate ?? null,
              serialNumber: conservationRecord.serialNumber ?? null,
              issuedAt: toIsoStringOrNull(conservationRecord.issuedAt),
            }
          : null,
        signers,
        downloads: {
          nom151: Boolean(seal?.integrityEvidence?.certificatePdfBase64),
          timestamp: Boolean(seal?.timestampEvidence?.fileBase64),
          canonical: Boolean(seal?.canonicalPayload),
        },
        // Evidencia cruda (DER/ASN.1 en Base64) para que la vista pública la decodifique en el
        // navegador y la descargue — a diferencia de `downloads`, que solo confirma si el artefacto
        // existe para los enlaces que sirve el propio backend (ver `seal-artifacts.ts`).
        sealEvidence: {
          timestampFileBase64: seal?.timestampEvidence?.fileBase64 ?? null,
          integrityFileBase64: seal?.integrityEvidence?.fileBase64 ?? null,
        },
        integrityTsaCertificate,
      },
    };
  }

  /**
   * Completa la evidencia que faltaba y sella, si el documento estaba esperando.
   *
   * Se traga cualquier error a propósito: es una mejora oportunista dentro de una consulta de
   * lectura, y ni el SAT ni el proveedor de sellado pueden impedir que la vista pública se muestre.
   * Si algo falla, el documento sigue marcado como pendiente y el próximo visitante lo reintenta.
   */
  private async completePendingSealIfDue(
    document: DocumentEntity,
    signerCollaborators: CollaboratorEntity[],
  ): Promise<void> {
    if (!document.sealingPendingAt) {
      return;
    }

    try {
      const listo = await this.retryPendingSeal.execute(document);
      if (!listo) {
        return;
      }

      await this.documentService.sealAdvancedSignatures(
        document,
        signerCollaborators,
      );
    } catch (error) {
      this.logger.warn(
        `No se pudo completar el sellado pendiente del documento ${document.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * Resuelve la serie y el `notBefore` del certificado TSA de la evidencia NOM-151 para la sección
   * de esa constancia en la vista pública.
   *
   * Reutiliza los valores que `integrityEvidence` ya traiga —sellados desde `SealMapper` o
   * completados por una consulta anterior— sin volver a tocar el ASN.1. Si faltan (evidencia
   * histórica, o extracción fallida al sellar) reintenta la extracción y la persiste para no
   * reprocesar en cada visita; el guardado es best-effort, y si falla igual se muestra lo recién
   * extraído.
   *
   * Devuelve `null` cuando no se puede extraer, y el frontend no pinta el componente.
   */
  private async resolveIntegrityTsaCertificate(
    seal: SealEntity | null,
  ): Promise<PublicIntegrityTsaCertificate | null> {
    if (!seal) {
      return null;
    }

    const { certificateSerialNumber, certificateIssuedAt } =
      seal.integrityEvidence;
    if (certificateSerialNumber && certificateIssuedAt) {
      return {
        serialNumber: certificateSerialNumber,
        issuedAt: toIsoStringOrNull(certificateIssuedAt) as string,
      };
    }

    const extracted = extractTsaCertificateInfo(
      seal.integrityEvidence.fileBase64,
    );
    if (!extracted) {
      return null;
    }

    await this.sealDocumentUseCase
      .persistIntegrityCertificateInfo(seal, extracted)
      .catch(() => undefined);

    return {
      serialNumber: extracted.serialNumber,
      issuedAt: extracted.issuedAt.toISOString(),
    };
  }
}
