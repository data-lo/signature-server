import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { MinioService } from 'src/common/minio/minio.service';
import { BUCKET_TYPES_ENUM } from 'src/common/minio/enums/bucket-types.enum';
import { UserService } from 'src/user/user.service';

import { CollaboratorEntity } from '../entities/collaborator.entity';
import { COLABORATOR_TYPE_ENUM } from '../enum/colaborator-type.enum';
import { DOCUMENT_STATUS_ENUM } from '../enum/document-status.enum';
import {
  DocumentPublicViewResponse,
  PUBLIC_SEALING_STATUS_ENUM,
} from '../interfaces/responses/document-public-view-response';
import { toConservationRecord } from '../summary-document/conservation-record.util';
import { toIsoStringOrNull } from '../utils/iso-date.util';
import { SealDocumentUseCase } from '../seal/use-cases/seal-document.use-case';
import { SealEntity } from '../seal/entities/seal.entity';
import { DocumentSealingJobEntity } from '../seal/entities/document-sealing-job.entity';
import { SEALING_JOB_STATUS_ENUM } from '../seal/enums/sealing-job-status.enum';
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
    @InjectRepository(DocumentSealingJobEntity)
    private readonly sealingJobRepository: Repository<DocumentSealingJobEntity>,
    private readonly minioService: MinioService,
    private readonly userService: UserService,
    private readonly sealDocumentUseCase: SealDocumentUseCase,
    private readonly documentService: DocumentService,
  ) {}

  /**
   * Vista pública (sin autenticación) de un documento — ver historia "Visualización pública de
   * documentos firmados mediante MinIO". A diferencia de `getDocumentMinioURL`/
   * `findDetailForUser` (que resuelven una URL de Minio para CUALQUIER estatus vía
   * STATUS_BUCKET_MAP, apoyados en que ya hubo un chequeo de acceso previo), esta ruta no tiene
   * ningún control de acceso — cualquiera con el UUID puede llamarla — así que el gate por
   * `status === SIGNED` ocurre ANTES de siquiera considerar Minio: si el documento no está
   * firmado, ni se resuelve el bucket ni se llama a `minioService.getFile` (que es lo único que
   * genera la URL prefirmada), evitando exponer el archivo de un documento pendiente, rechazado,
   * cancelado o expirado.
   *
   * **Sólo lectura.** Abrir la vista no llama al SAT ni a Seal Service: el sellado lo ejecuta el
   * worker de `document_sealing_jobs`. Aquí sólo se consulta el estado del trabajo y la constancia
   * persistida. Lo único que puede escribir es la serie del certificado TSA, que se extrae de la
   * evidencia ya guardada, sin red.
   *
   * @param documentId - Documento.
   * @returns La vista pública.
   *
   * @throws {NotFoundException} Si el documento no existe.
   *
   * @example
   * ```ts
   * const view = await getPublicDocument.execute(documentId);
   * view.data.sealingStatus; // 'PENDING'
   * ```
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
          sealingStatus: PUBLIC_SEALING_STATUS_ENUM.NOT_REQUIRED,
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

    // Un documento sin contrato de sellado (biométrico), o cuyo sellado sigue pendiente o falló, se
    // muestra sin constancia. La vista pública tiene que poder mostrarse igual en ese caso.
    const seal = await this.sealDocumentUseCase
      .findByDocumentId(document.id)
      .catch(() => null);
    const sealingJob = await this.sealingJobRepository
      .findOne({
        where: { documentId: document.id },
        select: { id: true, status: true },
      })
      .catch(() => null);
    const sealingStatus = resolvePublicSealingStatus(
      sealingJob?.status ?? null,
      Boolean(seal),
      Boolean(document.sealingPendingAt),
    );

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
         * `true` mientras el documento espera su constancia. Se conserva por compatibilidad;
         * `sealingStatus` distingue además los fallos que ya no se resuelven solos.
         */
        sealingPending: document.sealingPendingAt !== null,
        sealingStatus,
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
   * Serie y `notBefore` del certificado TSA de la evidencia NOM-151, para la sección de esa
   * constancia en la vista pública.
   *
   * Si `integrityEvidence` ya los trae (se sella con esto desde `SealMapper`, o una consulta
   * anterior ya los completó), los usa tal cual y no vuelve a tocar el ASN.1. Si faltan —evidencia
   * histórica, o la extracción falló al sellar—, reintenta la extracción aquí; si esta vez sí
   * funciona, la persiste (best-effort: si el guardado falla, igual se muestra lo recién extraído,
   * y la próxima consulta simplemente lo reintenta) para no reprocesar en cada visita futura. Si no
   * se puede extraer, devuelve `null` y el frontend no pinta el componente.
   *
   * @param seal - Constancia del documento, o `null`.
   * @returns Serie y fecha del certificado TSA, o `null`.
   *
   * @example
   * ```ts
   * const tsa = await this.resolveIntegrityTsaCertificate(seal);
   * ```
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

/**
 * Estado público del sellado de un documento firmado, a partir de su trabajo y su constancia.
 *
 * - Con trabajo: `PENDING` (pendiente o reprogramado), `PROCESSING`, `COMPLETED`, `FAILED`
 *   (`DEAD`) o `RECONCILIATION_REQUIRED`.
 * - Sin trabajo (documentos cerrados antes de `document_sealing_jobs`, o biométricos):
 *   `COMPLETED` si tiene constancia, `PENDING` si conserva la marca `sealing_pending_at`, y
 *   `NOT_REQUIRED` en otro caso.
 *
 * No expone el código ni el mensaje del fallo: eso queda en el trabajo.
 *
 * @param jobStatus - Estado del trabajo, o `null` si no tiene.
 * @param hasSeal - Si el documento tiene constancia en `document_seals`.
 * @param pendingMark - Si conserva `sealing_pending_at`.
 * @returns El estado público.
 *
 * @example
 * ```ts
 * resolvePublicSealingStatus(SEALING_JOB_STATUS_ENUM.RETRY_SCHEDULED, false, true); // 'PENDING'
 * ```
 */
export function resolvePublicSealingStatus(
  jobStatus: SEALING_JOB_STATUS_ENUM | null,
  hasSeal: boolean,
  pendingMark: boolean,
): PUBLIC_SEALING_STATUS_ENUM {
  switch (jobStatus) {
    case SEALING_JOB_STATUS_ENUM.PENDING:
    case SEALING_JOB_STATUS_ENUM.RETRY_SCHEDULED:
      return PUBLIC_SEALING_STATUS_ENUM.PENDING;
    case SEALING_JOB_STATUS_ENUM.PROCESSING:
      return PUBLIC_SEALING_STATUS_ENUM.PROCESSING;
    case SEALING_JOB_STATUS_ENUM.COMPLETED:
      return PUBLIC_SEALING_STATUS_ENUM.COMPLETED;
    case SEALING_JOB_STATUS_ENUM.DEAD:
      return PUBLIC_SEALING_STATUS_ENUM.FAILED;
    case SEALING_JOB_STATUS_ENUM.RECONCILIATION_REQUIRED:
      return PUBLIC_SEALING_STATUS_ENUM.RECONCILIATION_REQUIRED;
    default:
      if (hasSeal) {
        return PUBLIC_SEALING_STATUS_ENUM.COMPLETED;
      }
      return pendingMark
        ? PUBLIC_SEALING_STATUS_ENUM.PENDING
        : PUBLIC_SEALING_STATUS_ENUM.NOT_REQUIRED;
  }
}
