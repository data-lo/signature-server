import { DeepPartial } from 'typeorm';

import { SealDocumentDto } from '../dto/seal-document.dto';
import { SealEntity } from '../entities/seal.entity';
import { SealDocumentResponse } from '../interfaces/seal-document-response.interface';

/** Traduce la respuesta del proveedor externo al modelo de persistencia local. */
export class SealMapper {
  static toEntity(
    dto: SealDocumentDto,
    response: SealDocumentResponse,
  ): DeepPartial<SealEntity> {
    return {
      documentId: response.documentId,
      signatureHash: response.signHashHex,
      canonicalPayload: JSON.stringify(dto),
      timestampSeal: {
        isValid: response.timeStamp.status,
        processedHash: response.timeStamp.hashProcessed,
        tokenBase64: response.timeStamp.fileBase64,
        evidenceId: response.timeStamp.uuid,
      },
      integritySeal: {
        isValid: response.nom151.status,
        processedHash: response.nom151.hashProcessed,
        tokenBase64: response.nom151.file,
        evidenceId: response.nom151.uuid,
        certificatePdfBase64: response.nom151.pdfFile,
      },
    };
  }
}
