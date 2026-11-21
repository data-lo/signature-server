import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { HashService } from 'src/common/hash/hash.service';
import { BUCKET_TYPES_ENUM } from 'src/common/minio/enums/bucket-types.enum';
import { MinioService } from 'src/common/minio/minio.service';

import { DocumentService } from '../document.service';
import { CollaboratorEntity } from '../entities/collaborator.entity';
import { COLABORATOR_TYPE_ENUM } from '../enum/colaborator-type.enum';
import { SealEntity } from '../seal/entities/seal.entity';
import {
  SealedEvidencePdfUpdateException,
  SignedPdfIntegrityException,
} from '../seal/exceptions/seal.exceptions';
import { SealedDocumentEvidenceRefresher } from '../seal/interfaces/sealed-document-evidence-refresher.interface';
import { ProcessDocumentSealingJobUseCase } from '../seal/use-cases/process-document-sealing-job.use-case';
import { collaboratorDisplayName } from '../utils/collaborator-display.util';

/**
 * Regenera el PDF final de un documento con su constancia: la fase `UPDATING_EVIDENCE_PDF` del
 * trabajo de sellado.
 *
 * Al cerrar el documento, la hoja anexa se armó sin constancia (todavía no existía). Aquí se vuelve
 * a armar con la constancia persistida, con la misma lógica de siempre
 * (`DocumentService.attachSignaturesSheet`):
 * - Se lee el PDF firmado de `signed_documents`, que nunca lleva la hoja. Así repetir esta fase
 *   produce siempre el mismo resultado y nunca anexa una hoja sobre otra.
 * - Antes de anexar se comprueba que ese PDF siga teniendo el `signedHash` del documento: si no, la
 *   hoja certificaría un archivo distinto del que se firmó.
 * - El resultado reemplaza el objeto de `finalized_documents`. El original, el PDF firmado y
 *   `signedHash` no se tocan, y nada se vuelve a firmar.
 *
 * Vive en `DocumentModule` porque depende de `DocumentService`; se registra en el procesador de
 * `SealModule` al arrancar (ver `SealedDocumentEvidenceRefresher`), sin que `SealModule` importe
 * `DocumentModule`.
 */
@Injectable()
export class RefreshSealedDocumentEvidenceService
  implements SealedDocumentEvidenceRefresher, OnModuleInit
{
  private readonly logger = new Logger(
    RefreshSealedDocumentEvidenceService.name,
  );

  constructor(
    private readonly documentService: DocumentService,
    @InjectRepository(CollaboratorEntity)
    private readonly collaboratorRepository: Repository<CollaboratorEntity>,
    private readonly minioService: MinioService,
    private readonly hashService: HashService,
    private readonly processor: ProcessDocumentSealingJobUseCase,
  ) {}

  /**
   * Se registra como implementación de la fase del PDF en el procesador de trabajos.
   *
   * @returns Nada.
   *
   * @example
   * ```ts
   * // Lo llama Nest al iniciar DocumentModule.
   * service.onModuleInit();
   * ```
   */
  onModuleInit(): void {
    this.processor.useEvidenceRefresher(this);
  }

  /**
   * Arma la hoja con la constancia y publica el PDF final.
   *
   * @param documentId - Documento en `SIGNED`.
   * @param seal - Constancia persistida.
   * @returns Nada, cuando el PDF final ya está publicado.
   *
   * @throws {SignedPdfIntegrityException} Si el PDF firmado ya no tiene el `signedHash` registrado.
   * @throws {SealedEvidencePdfUpdateException} Si MinIO o la generación de la hoja fallan; repetir
   *   sólo vuelve a esta fase.
   * @throws {NotFoundException} Si el documento no existe.
   *
   * @example
   * ```ts
   * await refresher.refresh(job.documentId, seal);
   * ```
   */
  async refresh(documentId: string, seal: SealEntity): Promise<void> {
    const document = await this.documentService.findOne(documentId);
    const signers = await this.collaboratorRepository.find({
      where: { documentId, colaboratorType: COLABORATOR_TYPE_ENUM.SIGNER },
      relations: { account: { user: true } },
      order: { signingOrder: 'ASC', createdAt: 'ASC' },
    });

    let signedPdf: Buffer;
    try {
      signedPdf = await this.minioService.getFileInBytesFormat(
        document.objectKey,
        BUCKET_TYPES_ENUM.SIGNED_DOCUMENTS,
      );
    } catch (error) {
      this.logger.error(
        `No se pudo leer el PDF firmado del documento ${documentId}: ${errorMessage(error)}`,
      );
      throw new SealedEvidencePdfUpdateException();
    }

    if (
      (await this.hashService.generateFileHash(signedPdf)) !==
      document.signedHash
    ) {
      this.logger.error(
        `El PDF firmado del documento ${documentId} no coincide con su signedHash; no se anexa la hoja.`,
      );
      throw new SignedPdfIntegrityException();
    }

    try {
      await this.documentService.attachSignaturesSheet(
        document,
        signers,
        signedPdf,
        signers.map(collaboratorDisplayName).join(', '),
        seal,
      );
    } catch (error) {
      this.logger.error(
        `No se pudo publicar el PDF final del documento ${documentId}: ${errorMessage(error)}`,
      );
      throw new SealedEvidencePdfUpdateException();
    }

    this.logger.log(
      `PDF final del documento ${documentId} actualizado con su constancia.`,
    );
  }
}

/**
 * Mensaje de un error desconocido, para el log.
 *
 * @param error - Lo que se capturó.
 * @returns Su mensaje.
 *
 * @example
 * ```ts
 * errorMessage(new Error('x')); // 'x'
 * ```
 */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
