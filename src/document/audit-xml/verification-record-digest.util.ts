import { createHash } from 'crypto';

/** Forma del digest guardado en `document_seals.verification_record_digest`: SHA-256 en hex. */
export const VERIFICATION_RECORD_DIGEST_PATTERN = /^[0-9a-f]{64}$/;

/**
 * SHA-256 del XML de auditoría (el registro de verificación), en hexadecimal minúsculo.
 *
 * Se calcula sobre los bytes UTF-8 del texto tal como sale de `buildDocumentAuditXml`: cualquier
 * cambio de un byte —también de espacios o saltos de línea— produce otro digest.
 *
 * @param auditXml - XML de auditoría SIN `generatedAt`.
 * @returns 64 caracteres hexadecimales.
 *
 * @example
 * ```ts
 * computeVerificationRecordDigest('<documentAudit />');
 * // 'a3f1…' (64 caracteres)
 * ```
 */
export function computeVerificationRecordDigest(auditXml: string): string {
  return createHash('sha256').update(auditXml, 'utf8').digest('hex');
}
