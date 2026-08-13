/**
 * Respuesta de `POST /seal/signature` de Seal Service (ver `SignatureSealResponse` allá).
 *
 * Seal Service no tiene base de datos: devuelve todo el material de reconstrucción y esta es la
 * única oportunidad de guardarlo. De ahí que se persista la cadena canónica y no solo el hash —
 * un hash suelto no se puede verificar contra nada.
 */
export interface SealDocumentResponse {
  documentId: string;
  /** `sha256(canonicalString)` — es lo que efectivamente se selló ante el PSC. */
  hashHex: string;
  /** Función de hash usada. Necesaria para recomputar sin adivinar. */
  hashAlgorithm: string;
  /**
   * Versión del algoritmo de canonicalización con el que se armó `canonicalString`. Encabeza esa
   * misma cadena, así que persistirla es suficiente para saber con qué reglas verificar el sello
   * dentro de años, incluso si las reglas cambiaron desde entonces.
   */
  hashVersion: string;
  /**
   * Preimagen literal del hash: quien la tenga puede recomputar `sha256(canonicalString)` y
   * comprobar que da `hashHex`, sin reimplementar la canonicalización de Seal Service.
   */
  canonicalString: string;
  /** ISO-8601 de la emisión del sello. */
  sealedAt: string;
  timeStamp: TimestampSealResponse;
  nom151: Nom151SealResponse;
}

export interface TimestampSealResponse {
  status: boolean;
  hashProcessed: string;
  fileBase64: string;
  uuid: string;
}

export interface Nom151SealResponse {
  status: boolean;
  hashProcessed: string;
  file: string;
  uuid: string;
  pdfFile: string;
}
