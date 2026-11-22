import { createHash } from 'crypto';

/**
 * SHA-256 del PDF final (el firmado con la hoja de firmas y evidencia anexada), en hexadecimal
 * minúsculo: el valor de `documents.final_document_digest`.
 *
 * Se calcula sobre los mismos bytes que se suben a `finalized_documents` (`uploadPdfAObject` no los
 * transforma), así que volver a hashear el objeto almacenado da el mismo valor. No sirve
 * `signed_hash`: ese es el PDF ANTES de la hoja.
 *
 * @param finalPdf - Bytes del PDF final, tal como se almacenan.
 * @returns 64 caracteres hexadecimales.
 *
 * @example
 * ```ts
 * computeFinalDocumentDigest(finalizedDocument); // 'e3b0c442…' (64 caracteres)
 * ```
 */
export function computeFinalDocumentDigest(finalPdf: Buffer): string {
  return createHash('sha256').update(finalPdf).digest('hex');
}
