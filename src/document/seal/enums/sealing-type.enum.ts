/**
 * Contrato de Seal Service con el que se sella un documento (`document_sealing_jobs.seal_type`).
 *
 * - `ADVANCED`: firmas con e.firma (`POST /seal/signature`). La evidencia es criptográfica: firma,
 *   certificado y respuesta OCSP de cada firmante.
 * - `SIMPLE`: firmas simples (`POST /seal/simple-signature`). La evidencia es la identidad del
 *   firmante, el código de un solo uso con que se acreditó y su rúbrica.
 *
 * La firma biométrica no tiene contrato de sellado y no genera trabajo (ver
 * `resolveSealingType`). Se guarda como `varchar` con un `CHECK`
 * (`CHK_document_sealing_jobs_seal_type`).
 */
export enum SEALING_TYPE_ENUM {
  ADVANCED = 'ADVANCED',
  SIMPLE = 'SIMPLE',
}
