import { SealEntity } from '../seal/entities/seal.entity';

/**
 * Datos de la tabla "Información de la Constancia de Conservación (NOM-151)" de las hojas de
 * evidencia. Los tres renglones son los de las plantillas de referencia.
 */
export interface ConservationRecordInfo {
  /**
   * Identidad del certificado de la Autoridad de Sellado de Tiempo (el DN del PSC).
   *
   * Hoy NO se puede llenar: ni Seal Service ni el PSC devuelven este dato por separado — vive
   * dentro del token RFC 3161 (`timestampSeal.tokenBase64`), en su estructura ASN.1. Ver la nota
   * de `toConservationRecord`.
   */
  tsaCertificate?: string | null;
  /** Número de serie del sello de tiempo. Mismo caso que `tsaCertificate`. */
  serialNumber?: string | null;
  /** Momento en que el PSC emitió la constancia (`SealEntity.sealedAt`). */
  issuedAt?: Date | string | null;
}

/**
 * Traduce el sello persistido a lo que la hoja imprime en la tabla NOM-151. `null` cuando el
 * documento no tiene sello (firma simple, o sellado fallido: es best-effort).
 *
 * **Por qué solo se llena "EMITIDO"**: de los tres renglones de la plantilla, es el único que
 * existe como dato propio. El DN del certificado (TSA) y el número de serie del sello viajan
 * únicamente dentro del token RFC 3161 que emite el PSC — un CMS SignedData con la estructura
 * TSTInfo — y ni PSC CODEX ni Seal Service los exponen por separado (ver
 * `PscCodexResponseHash`: solo `status`, `hashProcessed`, `fileBase64` y `uuid`).
 *
 * Sacarlos exige parsear ASN.1 del token, y ese parseo corresponde a Seal Service —que es quien
 * habla con el PSC y ya tiene el token en la mano—, no a cada consumidor de su respuesta. Cuando
 * los devuelva, llenarlos acá es mapear dos campos más.
 */
export function toConservationRecord(
  seal: SealEntity | null | undefined,
): ConservationRecordInfo | null {
  if (!seal) {
    return null;
  }

  return {
    tsaCertificate: null,
    serialNumber: null,
    issuedAt: seal.sealedAt,
  };
}
