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
  CANCELLED_DOCUMENTS = 'cancelled_documents',
  REJECTED_DOCUMENTS = 'rejected_documents',
  OFICIAL_CARDS = 'oficial_cards',
  SIGNATURE_IMAGES = 'signature_images',
}
