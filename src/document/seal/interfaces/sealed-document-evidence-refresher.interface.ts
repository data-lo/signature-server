import type { SealEntity } from '../entities/seal.entity';

/**
 * Regenera el PDF final de un documento con su constancia ya persistida: la fase
 * `UPDATING_EVIDENCE_PDF` de `ProcessDocumentSealingJobUseCase`.
 *
 * Es un puerto porque la hoja de evidencia vive en `DocumentModule`, que importa `SealModule`; si el
 * procesador dependiera de `DocumentService` habría un ciclo. `DocumentModule` registra su
 * implementación (`RefreshSealedDocumentEvidenceService`) al arrancar con
 * `ProcessDocumentSealingJobUseCase.useEvidenceRefresher`.
 *
 * Toda implementación debe ser repetible sin efectos acumulados: parte del PDF firmado de
 * `signed_documents`, nunca del final, y reemplaza el objeto de `finalized_documents`. Al terminar
 * guarda `document_seals.verification_record_digest`, el SHA-256 del XML de auditoría ya con el PDF
 * final, porque es el último punto en que toda la evidencia existe.
 */
export interface SealedDocumentEvidenceRefresher {
  /**
   * @param documentId - Documento en `SIGNED`.
   * @param seal - Constancia persistida que la hoja debe mostrar.
   * @returns Nada, cuando el PDF final ya está publicado y su digest guardado.
   *
   * @throws {SealedEvidencePdfUpdateException} Si MinIO o la generación de la hoja fallan.
   * @throws {SignedPdfIntegrityException} Si el PDF firmado ya no tiene el `signedHash` registrado.
   * @throws {VerificationRecordDigestException} Si el digest del XML de auditoría no se pudo registrar.
   */
  refresh(documentId: string, seal: SealEntity): Promise<void>;
}
