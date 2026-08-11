/**
 * Contrato del Seal Service (repositorio `seal-service`, `POST /seal/signature`).
 *
 * Se declara aquí en vez de importarse porque son dos servicios desplegados por separado: este
 * archivo es la copia del contrato del lado del consumidor. Si cambia allá, cambia aquí — los
 * tipos NO se comparten por código.
 */

/** Datos públicos del certificado del SAT — mismos campos que `SATCertificate` de EfirmaService. */
export interface SealCertificate {
  rfc: string;
  name: string;
  serialNumber: string;
  certificateNumber: string;
  certificatePem: string;
}

/** Una firma avanzada dentro del arreglo que se manda a sellar. */
export interface SealSignature {
  signatureBase64: string;
  algorithm: string;
  /** ISO 8601. `SignatureResult.signedAt` es un Date y se serializa al construir la petición. */
  signedAt: string;
  certificate: SealCertificate;
}

/** Cuerpo de `POST /seal/signature`. */
export interface SealSignatureRequest {
  documentId: string;
  originalHash: string;
  signatures: SealSignature[];
}

/**
 * Respuesta del Seal Service. `timeStamp` y `nom151` se tipan como `unknown` a propósito: la
 * historia dejó pendiente el detalle de qué se almacena de ellos ("cuando esté configurada, se
 * agregará el detalle abajo en un comentario"), así que se persiste la respuesta íntegra sin
 * imponerle una forma que todavía no está definida. Lo que sí se conoce hoy (ver
 * `SealService.sealSigatures` y `buildZip` en seal-service) es que `timeStamp` trae un
 * `fileBase64` y `nom151` un `file` y un `pdfFile`, todos en base64.
 */
export interface SealSignatureResponse {
  documentId: string;
  hashHex: string;
  timeStamp: unknown;
  nom151: unknown;
}
