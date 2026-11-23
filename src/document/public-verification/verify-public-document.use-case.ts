import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { DocumentEntity } from '../entities/document.entity';
import { SealEntity } from '../seal/entities/seal.entity';
import { toIsoStringOrNull } from '../utils/iso-date.util';
import {
  VERIFICATION_ARTIFACT_TYPE_ENUM,
  VERIFICATION_MESSAGES,
  VERIFICATION_STATUS_ENUM,
  type DocumentVerificationResponse,
} from './public-verification.types';
import {
  VERIFICATION_FILE_PROBLEM_ENUM,
  type VerificationFileAnalysis,
} from './verification-file-analyzer';

/** Respuesta envuelta como el resto de la vista pública. */
export interface PublicVerificationResult {
  success: true;
  message: string;
  data: DocumentVerificationResponse;
}

/** Columnas del documento que se publican en un `VALID`. */
type VerifiedDocument = Pick<DocumentEntity, 'id' | 'fileName' | 'signedAt'>;

/**
 * `POST /document/public/verify`: decide si un XML de auditoría o un PDF final corresponde a un
 * documento firmado, comparando su SHA-256 con las huellas indexadas al completar la firma:
 *
 * - PDF → `documents.final_document_digest`. Coincide: `VALID`; si no, `NOT_FOUND`.
 * - XML → `document_seals.verification_record_digest`. Coincide: `VALID`. Si no, se busca el
 *   `documentId` de la raíz (ya validado como UUID por el analizador): si el documento existe y
 *   tiene huella registrada, `COMPROMISED` (es su XML, pero modificado); si no, `NOT_FOUND`.
 *
 * Recibe sólo el análisis del archivo (hash, tipo e id), nunca el archivo: no hay nada que
 * persistir ni que registrar. En `COMPROMISED` y `NOT_FOUND` no se publica nada del documento.
 */
@Injectable()
export class VerifyPublicDocumentUseCase {
  private readonly logger = new Logger(VerifyPublicDocumentUseCase.name);

  constructor(
    @InjectRepository(DocumentEntity)
    private readonly documentRepository: Repository<DocumentEntity>,
  ) {}

  /**
   * Resuelve el estado de verificación del archivo analizado.
   *
   * @param analysis - Análisis de `VerificationFileAnalyzer`, o `undefined` si no llegó archivo.
   * @returns La respuesta pública con estado, artefacto, mensaje y, sólo si es `VALID`, el documento.
   *
   * @throws {QueryFailedError} Si falla la base (se responde 500: no es un problema del archivo).
   *
   * @example
   * ```ts
   * const { data } = await useCase.execute(file?.verification);
   * data.status; // 'VALID'
   * ```
   */
  async execute(
    analysis: VerificationFileAnalysis | undefined,
  ): Promise<PublicVerificationResult> {
    const response = await this.resolve(analysis);

    // Sólo el resultado: ni el hash, ni el nombre del archivo, ni su contenido.
    this.logger.log(
      `Verificación pública: ${response.status}${response.artifactType ? ` (${response.artifactType})` : ''}`,
    );

    return { success: true, message: response.message, data: response };
  }

  private async resolve(
    analysis: VerificationFileAnalysis | undefined,
  ): Promise<DocumentVerificationResponse> {
    if (!analysis) {
      return result(VERIFICATION_STATUS_ENUM.UNSUPPORTED_FILE);
    }
    if (analysis.ok === false) {
      return result(
        analysis.problem === VERIFICATION_FILE_PROBLEM_ENUM.UNSUPPORTED
          ? VERIFICATION_STATUS_ENUM.UNSUPPORTED_FILE
          : VERIFICATION_STATUS_ENUM.INVALID_FILE,
      );
    }

    const { artifactType, digest } = analysis;

    if (artifactType === VERIFICATION_ARTIFACT_TYPE_ENUM.FINAL_DOCUMENT) {
      const document = await this.findByFinalDocumentDigest(digest);
      return document
        ? valid(artifactType, document)
        : result(VERIFICATION_STATUS_ENUM.NOT_FOUND, artifactType);
    }

    const document = await this.findByVerificationRecordDigest(digest);
    if (document) {
      return valid(artifactType, document);
    }

    const hasRegisteredRecord =
      analysis.documentId !== null &&
      (await this.hasRegisteredVerificationRecord(analysis.documentId));

    return result(
      hasRegisteredRecord
        ? VERIFICATION_STATUS_ENUM.COMPROMISED
        : VERIFICATION_STATUS_ENUM.NOT_FOUND,
      artifactType,
    );
  }

  /**
   * Si el documento existe Y tiene una huella del XML registrada.
   *
   * Sin huella registrada (sellado antes de la migración 100, firma biométrica, sellado todavía
   * pendiente) no hay contra qué comparar: afirmar que el archivo fue alterado sería falso, así que
   * ese caso queda en `NOT_FOUND` ("no existe un documento verificable").
   */
  private async hasRegisteredVerificationRecord(
    documentId: string,
  ): Promise<boolean> {
    const count = await this.documentRepository
      .createQueryBuilder('document')
      .innerJoin(SealEntity, 'seal', 'seal.documentId = document.id')
      .where('document.id = :documentId', { documentId })
      .andWhere('seal.verificationRecordDigest IS NOT NULL')
      .getCount();
    return count > 0;
  }

  /** Busca por `final_document_digest` (índice parcial `IDX_documents_final_document_digest`). */
  private findByFinalDocumentDigest(
    digest: string,
  ): Promise<VerifiedDocument | null> {
    return this.documentRepository
      .createQueryBuilder('document')
      .select(['document.id', 'document.fileName', 'document.signedAt'])
      .where('document.finalDocumentDigest = :digest', { digest })
      .orderBy('document.signedAt', 'DESC')
      .getOne();
  }

  /**
   * Busca por `verification_record_digest` (índice parcial
   * `IDX_document_seals_verification_record_digest`).
   */
  private findByVerificationRecordDigest(
    digest: string,
  ): Promise<VerifiedDocument | null> {
    return this.documentRepository
      .createQueryBuilder('document')
      .select(['document.id', 'document.fileName', 'document.signedAt'])
      .innerJoin(SealEntity, 'seal', 'seal.documentId = document.id')
      .where('seal.verificationRecordDigest = :digest', { digest })
      .orderBy('document.signedAt', 'DESC')
      .getOne();
  }
}

function result(
  status: VERIFICATION_STATUS_ENUM,
  artifactType?: VERIFICATION_ARTIFACT_TYPE_ENUM,
): DocumentVerificationResponse {
  return {
    status,
    ...(artifactType && { artifactType }),
    message: VERIFICATION_MESSAGES[status],
  };
}

function valid(
  artifactType: VERIFICATION_ARTIFACT_TYPE_ENUM,
  document: VerifiedDocument,
): DocumentVerificationResponse {
  return {
    ...result(VERIFICATION_STATUS_ENUM.VALID, artifactType),
    document: {
      id: document.id,
      fileName: document.fileName,
      signedAt: toIsoStringOrNull(document.signedAt),
    },
  };
}
