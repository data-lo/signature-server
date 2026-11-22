import { Injectable, Logger } from '@nestjs/common';

import { SealEntity } from '../seal/entities/seal.entity';
import { VerificationRecordDigestException } from '../seal/exceptions/seal.exceptions';
import { SealDocumentUseCase } from '../seal/use-cases/seal-document.use-case';
import { DocumentAuditXmlService } from './document-audit-xml.service';
import { computeVerificationRecordDigest } from './verification-record-digest.util';

/**
 * Calcula y guarda la huella de integridad del expediente de auditoría de un documento sellado:
 * el SHA-256 del XML de auditoría en `document_seals.verification_record_digest`.
 *
 * Se llama al final de la fase `UPDATING_EVIDENCE_PDF` (ver `RefreshSealedDocumentEvidenceService`),
 * cuando ya existe toda la evidencia: la constancia de Seal Service y el PDF final con la hoja que
 * la muestra. El XML se arma con `DocumentAuditXmlService` igual que la descarga pública pero SIN
 * `generatedAt`, así que sólo depende de la evidencia guardada: volver a armarlo con la misma
 * evidencia produce el mismo digest.
 */
@Injectable()
export class RecordVerificationRecordDigestUseCase {
  private readonly logger = new Logger(
    RecordVerificationRecordDigestUseCase.name,
  );

  constructor(
    private readonly auditXml: DocumentAuditXmlService,
    private readonly sealDocument: SealDocumentUseCase,
  ) {}

  /**
   * Arma el registro de verificación, calcula su SHA-256 y lo guarda en la constancia.
   *
   * @param documentId - Documento en `SIGNED` con el PDF final ya publicado.
   * @param seal - Constancia persistida del documento.
   * @returns El digest guardado (64 caracteres hexadecimales).
   *
   * @throws {VerificationRecordDigestException} Si el XML no se pudo armar (evidencia ilegible en
   *   MinIO, documento fuera de `SIGNED`…) o el digest no se pudo guardar. Reintentable.
   *
   * @example
   * ```ts
   * const digest = await recordDigest.execute(documentId, seal);
   * digest.length; // 64
   * ```
   */
  async execute(documentId: string, seal: SealEntity): Promise<string> {
    let digest: string;

    try {
      const auditXml = await this.auditXml.build(documentId, { seal });
      digest = computeVerificationRecordDigest(auditXml);
      await this.sealDocument.persistVerificationRecordDigest(seal.id, digest);
    } catch (error) {
      // Sólo el motivo: el XML lleva la CURP y la INE de los firmantes y nunca se registra.
      this.logger.error(
        `No se pudo registrar el digest del XML de auditoría del documento ${documentId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      throw new VerificationRecordDigestException();
    }

    this.logger.log(
      `Digest del XML de auditoría registrado para el documento ${documentId}.`,
    );

    return digest;
  }
}
