import { Injectable, NotFoundException } from '@nestjs/common';

import { DOCUMENT_STATUS_ENUM } from '../enum/document-status.enum';
import {
  SEAL_ARTIFACT_DESCRIPTORS,
  SEAL_ARTIFACT_ENUM,
  type PublicSealArtifact,
} from '../seal/seal-artifacts';
import { SealDocumentUseCase } from '../seal/use-cases/seal-document.use-case';
import { DocumentService } from '../document.service';

/**
 * `GET /document/public/:id/seal/:artifact`: descarga una pieza de la constancia de conservación
 * NOM-151 — el sello de tiempo, el PDF de la constancia o el documento canónico que se selló.
 *
 * Pública como el resto de la vista pública: son evidencia pensada para verificarse por fuera,
 * con `openssl ts` o un visor de PDF, y exigir sesión para comprobarla iría en contra de para
 * qué existe.
 */
@Injectable()
export class GetPublicSealArtifactUseCase {
  constructor(
    private readonly documentService: DocumentService,
    private readonly sealDocument: SealDocumentUseCase,
  ) {}

  async execute(
    documentId: string,
    artifact: SEAL_ARTIFACT_ENUM,
  ): Promise<PublicSealArtifact> {
    const document = await this.documentService.findOne(documentId);

    if (document.status !== DOCUMENT_STATUS_ENUM.SIGNED) {
      throw new NotFoundException(
        'El documento todavía no se ha completado de firmar',
      );
    }

    const seal = await this.sealDocument.findByDocumentId(documentId);

    if (!seal) {
      throw new NotFoundException(
        'El documento no tiene constancia de conservación',
      );
    }

    const descriptor = SEAL_ARTIFACT_DESCRIPTORS[artifact];
    const rawValue = descriptor.read(seal);

    if (!rawValue) {
      throw new NotFoundException(
        `La constancia del documento no incluye ${descriptor.label}`,
      );
    }

    /**
     * Los tres artefactos se entregan tal como se persistieron, sin transformarlos: son evidencia
     * y cualquier reescritura los invalidaría. Los binarios del PSC se decodifican de su Base64 y
     * el XML canónico ya está en claro (ver `SealMapper.decodeCanonicalXml`).
     */
    return {
      content: Buffer.from(rawValue, descriptor.encoding),
      contentType: descriptor.contentType,
      fileName: `${descriptor.fileNamePrefix}-${documentId}${descriptor.extension}`,
    };
  }
}
