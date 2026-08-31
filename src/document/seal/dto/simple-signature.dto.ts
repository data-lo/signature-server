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

/**
 * Lo único que acompaña a la firma: la rúbrica.
 *
 * Aquí vivían `identityDocumentFrontImage` / `identityDocumentBackImage`, el anverso y reverso de
 * la INE, declarados opcionales porque la descarga desde Didit todavía no existe y por lo tanto
 * nunca se mandaban. Del otro lado NO eran opcionales: Seal Service los canonicalizaba sin
 * comprobar, así que cada envío moría con `TypeError: ... (reading 'replace')`, el 500 lo tragaba
 * el sellado best-effort (`DocumentService.sealSimpleSignatures`) y el documento se quedaba sin
 * fila en `document_seals`. Ese es el motivo por el que la tabla "Información de la Constancia de
 * Conservación (NOM-151)" de la hoja de firma simple —y la vista pública de verificación— salían
 * vacías: no es que la constancia no se imprimiera, es que nunca llegó a emitirse.
 *
 * Los campos se eliminan de los DOS contratos en vez de tolerarse: mientras no se descarguen de
 * Didit no hay nada que mandar, y un campo que nadie llena sólo invita a que el XML canónico
 * dependa de si vino o no. Cuando existan se agregan de vuelta a la vez en ambos lados, con su
 * versión de hash (`HASH_VERSION` en Seal Service).
 */
export interface SimpleSignatureMedia {
  /**
   * PNG de la rúbrica del firmante en Base64, sin prefijo `data:`.
   *
   * Base64 y no bytes crudos porque el cuerpo viaja como JSON, que no transporta binario. El
   * caso de uso valida que lo descargado de MinIO sea realmente un PNG antes de codificarlo.
   */
  signatureImage: string;
}
