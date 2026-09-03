import { CollaboratorEntity } from '../entities/collaborator.entity';
import { SIGNATURE_TYPE_ENUM } from '../enum/signature-type.enum';

/**
 * Determina si el documento se firmó con firma avanzada (e.firma), que es lo que decide cuál de las
 * dos hojas de evidencia se anexa al documento final.
 *
 * El tipo de firma es una decisión del documento y no de cada firmante: el flujo de creación lo
 * resuelve una vez y lo copia igual a todos sus SIGNER. Aun así exige `every` y no `some`: si alguna
 * fila vieja mezclara tipos, la hoja simple —que sí imprime a todos los firmantes— es el
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
