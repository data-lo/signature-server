/**
 * Contrato de `POST /seal/simple-signature`: qué mandamos a Seal Service cuando un documento de
 * firma simple queda firmado por todos sus firmantes.
 *
 * Interfaces y no clases con `class-validator`, a diferencia de `SealDocumentDto`: ese DTO
 * también entra por HTTP (`POST /seal` en `SealController`) y por eso se valida; éste es
 * únicamente de salida. Quien garantiza que ningún campo obligatorio viaje vacío es
 * `SendCompletedSimpleSignatureToSealUseCase`, que falla con el dato y el firmante señalados
 * antes de tocar la red.
 *
 * Todas las fechas son ISO 8601 en UTC (`Date.toISOString()`), el mismo formato que ya usa el
 * sellado de firma avanzada.
 */
export interface SimpleSignatureDTO {
  documentId: string;
  /** Hash del PDF tal como se subió, antes de estampar ninguna firma. */
  originalHash: string;
  /** Hash del PDF ya estampado con todas las firmas, sin la hoja de evidencia anexada. */
  signedHash: string;
  signatures: SimpleSignerSignature[];
}

export interface SimpleSignerSignature {
  /** CURP del firmante, tomada de su información personal canónica. */
  curp: string;
  email: string;
  name: string;
  lastName: string;
  /** Cuándo firmó este colaborador, ISO 8601. */
  signedAt: string;
  verificationData: SimpleSignatureVerificationData;
  signatureMedia: SimpleSignatureMedia;
}

/** Evidencia del código de un solo uso con el que el firmante acreditó su identidad. */
export interface SimpleSignatureVerificationData {
  code: string;
  /** Canal por el que se entregó el código. Hoy sólo existe el correo (`EMAIL_OTP`). */
  verificationMethod: string;
  /** Cuándo se consumió el código, ISO 8601. */
  usedAt: string;
}

export interface SimpleSignatureMedia {
  /**
   * PNG de la rúbrica del firmante en Base64, sin prefijo `data:`.
   *
   * Base64 y no bytes crudos porque el cuerpo viaja como JSON, que no transporta binario. El
   * caso de uso valida que lo descargado de MinIO sea realmente un PNG antes de codificarlo.
   */
  signatureImage: string;
  /**
   * Anverso de la INE verificada por Didit, en Base64 sin prefijo `data:` (el contrato de Seal
   * Service, que lo incluye tal cual en el XML canónico que sella).
   *
   * Obligatorio: sale del bucket privado `identity-documents` por la llave de
   * `personal_information`, y si falta el caso de uso no envía nada. Nunca es una URL.
   */
  identityDocumentFrontImage: string;
  /** Reverso de la INE verificada, con las mismas reglas que `identityDocumentFrontImage`. */
  identityDocumentBackImage: string;
}
