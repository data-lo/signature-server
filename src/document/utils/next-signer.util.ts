import { CollaboratorEntity } from '../entities/collaborator.entity';
import { COLABORATOR_TYPE_ENUM } from '../enum/colaborator-type.enum';
import { SIGNEE_STATUS_ENUM } from '../enum/signee-status.enum';

/**
 * Único punto de verdad para "a quién le toca firmar": el colaborador (colaboratorType=SIGNER)
 * con el signingOrder más bajo que siga PENDING. Antes existían 4 implementaciones
 * independientes de esta misma regla (findWithFilters, findDetailForUser, sign/reject,
 * notifyNextSigner) que podían divergir con el tiempo; todas deben pasar por aquí.
 */
export function getNextPendingSigner(
  collaborators: CollaboratorEntity[],
): CollaboratorEntity | null {
  return (
    collaborators
      .filter((c) => c.colaboratorType === COLABORATOR_TYPE_ENUM.SIGNER)
      .sort((a, b) => (a.signingOrder ?? 0) - (b.signingOrder ?? 0))
      .find((c) => c.status === SIGNEE_STATUS_ENUM.PENDING) ?? null
  );
}

/**
 * Es el turno de `signer` si es exactamente el próximo firmante pendiente — salvo que el
 * documento sea `isSequential=false` ("Firma Digital Simple en modalidad sin orden"), en cuyo
 * caso cualquier firmante PENDING puede firmar en cualquier momento, sin importar signingOrder.
 * `isSequential` por defecto en `true` para no alterar el comportamiento de ningún caller
 * existente que todavía no pasa este argumento explícitamente.
 */
export function isSignerTurn(
  signer: CollaboratorEntity,
  allSigners: CollaboratorEntity[],
  isSequential = true,
): boolean {
  if (!isSequential) {
    return signer.status === SIGNEE_STATUS_ENUM.PENDING;
  }
  const next = getNextPendingSigner(allSigners);
  return next?.id === signer.id;
}
