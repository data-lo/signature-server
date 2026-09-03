import { SealEntity } from '../seal/entities/seal.entity';
import { extractTsaCertificateInfo } from '../seal/utils/tsa-certificate.util';

/**
 * Datos de la tabla "Información de la Constancia de Conservación (NOM-151)" de las hojas de
 * evidencia. Los tres renglones son los de las plantillas de referencia.
 */
export interface ConservationRecordInfo {
  /**
   * Identidad del certificado de la Autoridad de Sellado de Tiempo: el CN de quien emitió la
   * evidencia NOM-151.
   */
  tsaCertificate?: string | null;
  /** Número de serie de ese certificado. */
  serialNumber?: string | null;
  /** Momento en que el PSC emitió la constancia (`SealEntity.sealedAt`). */
  issuedAt?: Date | string | null;
}

/**
 * Traduce el sello persistido a lo que la hoja imprime en su tabla NOM-151, o `null` si el documento
 * no tiene sello (firma simple, o sellado fallido: es best-effort).
 *
 * El certificado y la serie salen del certificado del PSC embebido en la evidencia, que `SealMapper`
 * extrae al sellar. Cuando faltan —evidencia histórica o archivo que el parser no reconoció— los
 * extrae del ASN.1 en el momento, igual que la vista pública: la hoja se genera una sola vez y queda
 * anexada al PDF para siempre, así que vale el intento antes de imprimir un renglón vacío que ya no
 * se puede corregir.
 */
export function toConservationRecord(
  seal: SealEntity | null | undefined,
): ConservationRecordInfo | null {
  if (!seal) {
    return null;
  }

  const { certificateSubjectCommonName, certificateSerialNumber, fileBase64 } =
    seal.integrityEvidence ?? {};

  const extracted =
    certificateSubjectCommonName && certificateSerialNumber
      ? null
      : extractTsaCertificateInfo(fileBase64 ?? '');

  return {
    tsaCertificate:
      certificateSubjectCommonName ?? extracted?.subjectCommonName ?? null,
    serialNumber: certificateSerialNumber ?? extracted?.serialNumber ?? null,
    issuedAt: seal.sealedAt,
  };
}
