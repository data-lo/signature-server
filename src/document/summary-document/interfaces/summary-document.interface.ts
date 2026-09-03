import { ConservationRecordInfo } from '../conservation-record.util';
/**
 * Datos de entrada para generar la hoja resumen (ver plantilla "Firmalo Hoja de Firmas").
 *
 * Desacoplado de DocumentEntity a propósito: el caller —el flujo de `finalizeSignedDocument`— arma
 * este objeto a partir de la entidad, para que SummaryDocumentService no dependa de TypeORM ni de
 * cómo se persiste cada dato.
 *
 * No lleva el cifrado del registro de auditoría ni el RFC del firmante, porque la plantilla vigente
 * no los contempla. Ninguno se pierde: el cifrado vive en `AuditChainEntity.chipher` y el RFC en
 * `CollaboratorEntity.rfc` (y dentro del certificado en la hoja avanzada). Volver a imprimirlos es
 * agregar el renglón; los datos siguen en su origen.
 */
export interface SummaryDocumentInfo {
  /** DocumentEntity.id */
  id: string;
  /** DocumentEntity.fileName */
  documentName: string;
  /** Hash del documento (DocumentEntity.signedHash una vez firmado, u originalHash antes). */
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
   * Constancia de conservación NOM-151 del PSC, o `null` si el documento no llegó a sellarse.
   *
   * La firma simple TAMBIÉN se sella (ver `SendCompletedSimpleSignatureToSealUseCase`): la tabla
   * salía vacía porque el sellado corría después de armar esta hoja, no porque no existiera.
   */
  conservationRecord?: ConservationRecordInfo | null;
}

/**
 * Un renglón de la sección "Firmas" por cada firmante del documento.
 *
 * No incluye geolocalización: el dato se sigue registrando en `CollaboratorEntity.geoLoc` y en la
 * cadena de auditoría, pero se quitó de este contrato en vez de dejarlo entrar sin usarse, que es
 * como vuelve a colarse a una plantilla sin que nadie lo note.
 */
export interface SummaryDocumentSigner {
  /** Nombre completo del firmante. */
  name: string;
  ipAddress: string;
  /** Código OTP usado para verificar la identidad del firmante, si aplica. */
  otpCode?: string | null;
  /** Momento en que el firmante completó su firma (CollaboratorEntity.signedAt). */
  signedAt?: Date | string | null;
}
