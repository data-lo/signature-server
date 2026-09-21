/**
 * Tipo de firma exigido a un documento y a cada uno de sus firmantes.
 *
 * Los valores van en MAYÚSCULAS desde la historia "Estandarizar enums signature_type y
 * collaborator_type": son el mismo texto que se persiste en `documents.signature_type` y
 * `collaborators.signature_type` (ver migración `UppercaseSignatureAndCollaboratorTypes`), el que
 * viaja en las respuestas de la API y el que compara el frontend en `lib/enums/document.ts`. No
 * confundir con el vocabulario comercial `BILLING_SIGNATURE_TYPE_ENUM` (`SIMPLE`/`ADVANCED`), que
 * ya estaba en mayúsculas y llama ADVANCED a lo que aquí es FIEL.
 */
export enum SIGNATURE_TYPE_ENUM {
  SIMPLE = 'SIMPLE',
  FIEL = 'FIEL',
}
