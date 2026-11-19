import { CollaboratorEntity } from '../../entities/collaborator.entity';
import { COLABORATOR_TYPE_ENUM } from '../../enum/colaborator-type.enum';
import { SIGNATURE_TYPE_ENUM } from '../../enum/signature-type.enum';
import { SEALING_TYPE_ENUM } from '../enums/sealing-type.enum';

/**
 * Contrato de sellado de un documento completo, o `null` si no tiene ninguno.
 *
 * Es una selección explícita por tipo de firma, no un "todo lo que no sea FIEL es simple":
 * - Todos los firmantes con `FIEL` → `ADVANCED`.
 * - Todos con `SIMPLE`, o sin tipo (filas anteriores a que existiera la firma avanzada, que eran
 *   simples) → `SIMPLE`.
 * - Cualquier firmante `BIOMETRIC`, una mezcla de tipos o ningún firmante → `null`: no hay
 *   contrato de Seal Service para esa evidencia y el documento no genera trabajo.
 *
 * Exige `every`, igual que `isAdvancedSignatureDocument`, que elige la hoja de evidencia: un
 * documento se sella con el mismo flujo con el que se imprime su hoja.
 *
 * @param collaborators - Colaboradores del documento; sólo cuentan los `SIGNER`.
 * @returns El tipo de sellado, o `null` si el documento no se sella.
 *
 * @example
 * ```ts
 * resolveSealingType([fielSigner, fielSigner]); // SEALING_TYPE_ENUM.ADVANCED
 * resolveSealingType([biometricSigner]); // null
 * ```
 */
export function resolveSealingType(
  collaborators: Pick<
    CollaboratorEntity,
    'colaboratorType' | 'signatureType'
  >[],
): SEALING_TYPE_ENUM | null {
  const signers = collaborators.filter(
    (collaborator) =>
      collaborator.colaboratorType === COLABORATOR_TYPE_ENUM.SIGNER,
  );

  if (signers.length === 0) {
    return null;
  }

  if (
    signers.every((signer) => signer.signatureType === SIGNATURE_TYPE_ENUM.FIEL)
  ) {
    return SEALING_TYPE_ENUM.ADVANCED;
  }

  if (
    signers.every(
      (signer) =>
        signer.signatureType === SIGNATURE_TYPE_ENUM.SIMPLE ||
        signer.signatureType === null ||
        signer.signatureType === undefined,
    )
  ) {
    return SEALING_TYPE_ENUM.SIMPLE;
  }

  return null;
}
