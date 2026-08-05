/**
 * Datos de entrada para generar la hoja resumen (ver plantilla de referencia "Firmalo Hoja de
 * Firmas"). Deliberadamente desacoplado de DocumentEntity: el caller (p.ej. el flujo de
 * finalizeSignedDocument en document.service.ts) es quien arma este objeto a partir de la
 * entidad real, para que SummaryDocumentService no dependa de TypeORM ni de cómo se persiste
 * cada dato.
 */
export interface SummaryDocumentInfo {
  /** DocumentEntity.id */
  id: string;
  /** DocumentEntity.fileName */
  documentName: string;
  /** Hash del documento (DocumentEntity.signedHash una vez firmado, u originalHash antes). */
  hash: string;
  /**
   * Copia cifrada del registro de auditoría asociado (ver HashService.generateCiperHash /
   * AuditChainEntity.chipher) — es lo que la plantilla de referencia rotula "Cifrado".
   */
  cipher: string;
  totalPages: number;
  /** Email de quien creó el documento (DocumentEntity.requestedBy.email). */
  createdBy: string;
  /**
   * Contenido a codificar en el QR del pie de página (típicamente la URL de verificación
   * pública del documento). Si se omite, se codifica el `id` del documento.
   */
  verificationUrl?: string;
}

/** Un renglón de la sección "Firmas" por cada firmante del documento. */
export interface SummaryDocumentSigner {
  /** Nombre completo del firmante. */
  name: string;
  /** RFC del firmante — null/undefined cuando no aplica (ver CollaboratorEntity.rfc). */
  rfc?: string | null;
  ipAddress: string;
  /** Código OTP usado para verificar la identidad del firmante, si aplica. */
  otpCode?: string | null;
  /** Momento en que el firmante completó su firma (CollaboratorEntity.signedAt). */
  signedAt?: Date | string | null;
  /** Geolocalización capturada al firmar (CollaboratorEntity.geoLoc), ya formateada a texto. */
  geoLocation?: string | null;
}
