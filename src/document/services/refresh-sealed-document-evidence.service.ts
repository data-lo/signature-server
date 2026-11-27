import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { HashService } from 'src/common/hash/hash.service';
import { BUCKET_TYPES_ENUM } from 'src/common/minio/enums/bucket-types.enum';
import { MinioService } from 'src/common/minio/minio.service';

import { RecordVerificationRecordDigestUseCase } from '../audit-xml/record-verification-record-digest.use-case';
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
    private readonly recordVerificationRecordDigest: RecordVerificationRecordDigestUseCase,
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
   * Arma la hoja con la constancia, publica el PDF final y guarda las dos huellas de verificación,
   * en este orden: SHA-256 del PDF final (`documents.final_document_digest`) y SHA-256 del XML de
   * auditoría (`document_seals.verification_record_digest`), que incluye ese PDF.
   *
   * Si cualquiera falla, lanza y el trabajo no se completa: el documento sigue con
   * `sealing_pending_at` y nunca queda como sellado con evidencia incompleta.
   *
   * @param documentId - Documento en `SIGNED`.
   * @param seal - Constancia persistida.
   * @returns Nada, cuando el PDF final está publicado y sus dos huellas guardadas.
   *
   * @throws {SignedPdfIntegrityException} Si el PDF firmado ya no tiene el `signedHash` registrado.
   * @throws {SealedEvidencePdfUpdateException} Si MinIO, la generación de la hoja o el guardado de
   *   `final_document_digest` fallan; repetir sólo vuelve a esta fase.
   * @throws {VerificationRecordDigestException} Si el XML de auditoría no se pudo armar o su digest
   *   no se pudo guardar; repetir vuelve a esta fase.
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
      const finalDocumentDigest =
        await this.documentService.attachSignaturesSheet(
          document,
          signers,
          signedPdf,
          signers.map(collaboratorDisplayName).join(', '),
          seal,
        );
      // En cuanto se reemplaza el PDF final se reemplaza su huella: `final_document_digest` tiene
      // que describir siempre el objeto almacenado, aunque el XML falle después. Si esto falla, la
      // fase se repite completa y vuelve a publicar el mismo PDF.
      await this.documentService.persistFinalDocumentDigest(
        documentId,
        finalDocumentDigest,
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

    // Con la constancia y el PDF final publicados la evidencia está completa: se guarda la huella
    // del XML de auditoría. Va después del PDF porque el XML lo incluye.
    await this.recordVerificationRecordDigest.execute(documentId, seal);
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
