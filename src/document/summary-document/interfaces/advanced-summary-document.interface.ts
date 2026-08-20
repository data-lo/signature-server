import { ConservationRecordInfo } from '../conservation-record.util';

/**
 * Datos de entrada para generar la hoja de evidencia de FIRMA AVANZADA (ver documento de
 * referencia "Hoja de evidencia de firma avanzada"). Igual que su equivalente de firma simple,
 * está deliberadamente desacoplado de DocumentEntity: el caller (`attachSignaturesSheet` en
 * document.service.ts) arma este objeto a partir de la entidad real.
 *
 * Es un tipo aparte y no una extensión de `SummaryDocumentInfo` a propósito: la hoja avanzada NO
 * imprime "Cifrado" (su integridad se sostiene en la firma criptográfica y en la constancia
 * NOM-151, no en el encadenamiento de auditoría), y las dos hojas tienen que poder divergir sin
 * arrastrarse campos entre sí.
 */
export interface AdvancedSummaryDocumentInfo {
  /** DocumentEntity.id */
  id: string;
  /** DocumentEntity.fileName */
  documentName: string;
  /** Hash del documento (DocumentEntity.signedHash una vez firmado). */
  hash: string;
  totalPages: number;
  /** Email de quien creó el documento (DocumentEntity.requestedBy.email). */
  createdBy: string;
  /**
   * Contenido a codificar en el QR del pie de página (típicamente la URL de verificación
   * pública del documento). Si se omite, se codifica el `id` del documento.
   */
  verificationUrl?: string;
  /**
   * Constancia de conservación (NOM-151) emitida por el PSC para este documento, o `null` si no
   * llegó a emitirse — el sellado es best-effort. Ver `toConservationRecord`.
   */
  conservationRecord?: ConservationRecordInfo | null;
}

/**
 * Una tabla de la sección "Firmas" por cada firmante del documento.
 *
 * `certificateSerialNumber` y `electronicSignature` salen de `CollaboratorEntity.advancedSignature`
 * (el resultado no sensible de `EfirmaService.firmar` que se guardó al validar la e.firma) — nunca
 * de la llave privada ni de nada que el firmante haya subido.
 */
export interface AdvancedSummaryDocumentSigner {
  /** Nombre del firmante; preferentemente el que el SAT tiene registrado en el certificado. */
  name: string;
  ipAddress: string;
  /** `advancedSignature.certificate.serialNumber` — número de serie del certificado del SAT. */
  certificateSerialNumber?: string | null;
  /** `advancedSignature.signatureBase64` — la firma electrónica propiamente dicha. */
  electronicSignature?: string | null;
  /** Momento de la firma (`advancedSignature.signedAt`, con `CollaboratorEntity.signedAt` como respaldo). */
  signedAt?: Date | string | null;
  /** Geolocalización capturada al firmar (CollaboratorEntity.geoLoc), ya formateada a texto. */
  geoLocation?: string | null;
}
