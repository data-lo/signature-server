import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { MinioService } from 'src/shared/minio/minio.service';
import { BUCKET_TYPES_ENUM } from 'src/shared/minio/enums/bucket-types.enum';
import { UserService } from 'src/user/user.service';

import { CollaboratorEntity } from '../entities/collaborator.entity';
import { COLABORATOR_TYPE_ENUM } from '../enum/colaborator-type.enum';
import { DOCUMENT_STATUS_ENUM } from '../enum/document-status.enum';
import { DocumentPublicViewResponse } from '../interfaces/responses/document-public-view-response';
import { toConservationRecord } from '../summary-document/conservation-record.util';
import { toIsoStringOrNull } from '../utils/iso-date.util';
import { SealDocumentUseCase } from '../seal/use-cases/seal-document.use-case';
import { DocumentService } from '../document.service';

@Injectable()
export class GetPublicDocumentUseCase {
  constructor(
    @InjectRepository(CollaboratorEntity)
    private readonly collaboratorRepository: Repository<CollaboratorEntity>,
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
          conservationRecord: null,
          signers: signerCollaborators.map((collaborator) =>
            this.documentService.toPendingPublicSigner(collaborator),
          ),
          downloads: { nom151: false, timestamp: false, canonical: false },
        },
      };
    }

    // Versión definitiva (documento + hoja de firmas): es la única que se comparte hacia afuera.
    const { secureUrl, expiresIn } = await this.minioService.getFile(
      document.objectKey,
      BUCKET_TYPES_ENUM.FINALIZED_DOCUMENTS,
    );

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
        conservationRecord: conservationRecord
          ? {
              tsaCertificate: conservationRecord.tsaCertificate ?? null,
              serialNumber: conservationRecord.serialNumber ?? null,
              issuedAt: toIsoStringOrNull(conservationRecord.issuedAt),
            }
          : null,
        signers,
        downloads: {
          nom151: Boolean(seal?.integritySeal?.certificatePdfBase64),
          timestamp: Boolean(seal?.timestampSeal?.tokenBase64),
          canonical: Boolean(seal?.canonicalPayload),
        },
      },
    };
  }
}
