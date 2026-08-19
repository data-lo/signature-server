import { CollaboratorEntity } from '../entities/collaborator.entity';
import { SIGNATURE_TYPE_ENUM } from '../enum/signature-type.enum';

/**
 * ¿Este documento se firmó con firma avanzada (e.firma)? Es lo que decide cuál de las dos hojas de
 * evidencia se anexa al documento final (ver `attachSignaturesSheet`).
 *
 * El tipo de firma es una decisión del documento, no de cada firmante: `DocumentSignaturesService`
 * lo resuelve una sola vez al crearlo y lo copia igual a todos sus SIGNER, así que en la práctica
 * todos los firmantes comparten tipo. Aun así se exige `every` y no `some`: si alguna fila vieja o
 * inconsistente mezclara tipos, la hoja simple —que sí imprime a todos los firmantes— es el
 * comportamiento seguro, en vez de una hoja avanzada con firmantes sin certificado que mostrar.
 */
export function isAdvancedSignatureDocument(
  signerCollaborators: CollaboratorEntity[],
): boolean {
  return (
    signerCollaborators.length > 0 &&
    signerCollaborators.every(
      (collaborator) => collaborator.signatureType === SIGNATURE_TYPE_ENUM.FIEL,
    )
  );
}
