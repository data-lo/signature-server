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
 * Traduce el sello persistido a lo que la hoja imprime en la tabla NOM-151. `null` cuando el
 * documento no tiene sello (firma simple, o sellado fallido: es best-effort).
 *
 * **El certificado y la serie salen del certificado del PSC embebido en la evidencia NOM-151.**
 * `SealMapper` los extrae al sellar y los deja en `integrityEvidence`; acá sólo se leen. Cuando
 * faltan —evidencia histórica, sellada antes de que existiera la extracción, o un archivo que el
 * parser no reconoció— se intenta extraerlos del propio ASN.1 en el momento, que es lo mismo que
 * hace la vista pública: la hoja se genera una sola vez y queda anexada al PDF para siempre, así
 * que vale el intento antes de imprimir un renglón vacío que ya no se puede corregir.
 */
export function toConservationRecord(
  seal: SealEntity | null | undefined,
): ConservationRecordInfo | null {
  if (!seal) {
    return null;
  }

  const { certificateIssuerCommonName, certificateSerialNumber, fileBase64 } =
    seal.integrityEvidence ?? {};

  const extracted =
    certificateIssuerCommonName && certificateSerialNumber
      ? null
      : extractTsaCertificateInfo(fileBase64 ?? '');

  return {
    tsaCertificate:
      certificateIssuerCommonName ?? extracted?.issuerCommonName ?? null,
    serialNumber: certificateSerialNumber ?? extracted?.serialNumber ?? null,
    issuedAt: seal.sealedAt,
  };
}
