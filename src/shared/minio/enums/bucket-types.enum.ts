export enum BUCKET_TYPES_ENUM {
  CREATED_DOCUMENTS = 'created_documents',
  SIGNED_DOCUMENTS = 'signed_documents',
  /**
   * Versión definitiva que ve el usuario: el documento firmado MÁS la hoja de información de
   * firmas anexada (ver historia "Anexar hoja existente de información de firmas al documento
   * final"). Vive en un bucket aparte de `signed_documents` a propósito — ahí queda intacto el
   * documento firmado sin la hoja, que es el insumo con el que se calculó `signedHash`.
   */
  FINALIZED_DOCUMENTS = 'finalized_documents',
  /**
   * Vista previa del documento con las firmas registradas HASTA AHORA. Se regenera desde el original
   * cada vez que alguien firma, así que sólo existe mientras el documento está pendiente y al menos
   * un firmante ya firmó.
   *
   * Es una copia desechable y no una pieza legal: no se le calcula hash, no se anexa la hoja de
   * firmas y nada la referencia una vez que el documento queda SIGNED. Vive en su propio bucket para
   * que no pueda confundirse con `signed_documents`, cuyo contenido es el insumo de `signedHash` y
   * no admite versiones intermedias.
   */
  PARTIALLY_SIGNED_DOCUMENTS = 'partially_signed_documents',
  CANCELLED_DOCUMENTS = 'cancelled_documents',
  REJECTED_DOCUMENTS = 'rejected_documents',
  OFICIAL_CARDS = 'oficial_cards',
  SIGNATURE_IMAGES = 'signature_images',
}
