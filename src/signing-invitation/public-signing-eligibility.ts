import { CollaboratorEntity } from 'src/document/entities/collaborator.entity';
import { COLABORATOR_TYPE_ENUM } from 'src/document/enum/colaborator-type.enum';
import { SIGNATURE_TYPE_ENUM } from 'src/document/enum/signature-type.enum';
import { USER_LIFECYCLE_STATUS_ENUM } from 'src/user/enums/user-lifecycle-status.enum';

/**
 * Indica si un firmante puede firmar desde la invitación pública (`/sign/:token`), sin iniciar
 * sesión en la plataforma. Respeta los estados de colaborador y usuario existentes:
 *
 * - `SIMPLE`: sólo con un usuario **provisional** vinculado (lo crea la API de integración). La
 *   firma simple estampa una rúbrica que vive en un usuario, y un usuario `ACTIVE` firma desde su
 *   cuenta, como siempre.
 * - `FIEL` y `BIOMETRIC`: sólo **sin cuenta vinculada**, las mismas reglas que la firma de invitado
 *   que ya existía. Con cuenta, se firma desde ella.
 *
 * @param collaborator - Colaborador con `account.user` cargado si tiene cuenta.
 * @returns `true` si puede abrir una sesión pública de firma.
 *
 * @throws Nada.
 *
 * @example
 * ```ts
 * isPublicSigningAllowed(provisionalSimpleSigner); // true
 * ```
 */
export function isPublicSigningAllowed(
  collaborator: CollaboratorEntity,
): boolean {
  if (collaborator.colaboratorType !== COLABORATOR_TYPE_ENUM.SIGNER) {
    return false;
  }

  switch (collaborator.signatureType) {
    case SIGNATURE_TYPE_ENUM.SIMPLE:
      return (
        !!collaborator.accountId &&
        collaborator.account?.user?.lifecycleStatus ===
          USER_LIFECYCLE_STATUS_ENUM.PROVISIONED
      );
    case SIGNATURE_TYPE_ENUM.FIEL:
    case SIGNATURE_TYPE_ENUM.BIOMETRIC:
      return !collaborator.accountId;
    default:
      return false;
  }
}
