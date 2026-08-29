import { ConservationRecordInfo } from '../conservation-record.util';
/**
 * Datos de entrada para generar la hoja resumen (ver plantilla de referencia "Firmalo Hoja de
 * Firmas"). Deliberadamente desacoplado de DocumentEntity: el caller (p.ej. el flujo de
 * finalizeSignedDocument en document.service.ts) es quien arma este objeto a partir de la
 * entidad real, para que SummaryDocumentService no dependa de TypeORM ni de cómo se persiste
 * cada dato.
 */
/**
 * Dos campos que esta hoja SÍ imprimía antes y hoy no, porque la plantilla de referencia vigente
 * no los contempla (historia "Estructura y diseño de las hojas de firma"):
 *
 *  - **Cifrado**: la copia cifrada del registro de auditoría. No se pierde nada al no imprimirla —
 *    sigue viviendo en `AuditChainEntity.chipher`, que es su fuente de verdad; la hoja solo la
 *    mostraba. Se dejó de calcular en `attachSignaturesSheet` para no gastar un cifrado que nadie
 *    lee.
 *  - **RFC del firmante**: la plantilla identifica al firmante por nombre; el RFC sigue en
 *    `CollaboratorEntity.rfc` y en la hoja avanzada aparece dentro del certificado del SAT.
 *
 * Si la omisión resulta ser un olvido de las plantillas, volver a imprimirlos es agregar el
 * renglón correspondiente: los datos siguen disponibles en su origen.
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
 * La geolocalización se dejó de imprimir (historia "Ocultar geolocalización en hojas de firma
 * y vistas públicas"). El dato SIGUE registrándose y consultándose: vive en
 * `CollaboratorEntity.geoLoc` y en la cadena de auditoría, intacto. Lo que desapareció es su
 * camino hacia la presentación — por eso el campo se quitó de este contrato en vez de dejarlo
 * entrando sin usarse, que es como vuelve a colarse a una plantilla sin que nadie lo note.
 */
/** Un renglón de la sección "Firmas" por cada firmante del documento. */
export interface SummaryDocumentSigner {
  /** Nombre completo del firmante. */
  name: string;
  ipAddress: string;
  /** Código OTP usado para verificar la identidad del firmante, si aplica. */
  otpCode?: string | null;
  /** Momento en que el firmante completó su firma (CollaboratorEntity.signedAt). */
  signedAt?: Date | string | null;
}
