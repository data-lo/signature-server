import { CollaboratorEntity } from '../../entities/collaborator.entity';
import { collaboratorEmail } from '../../utils/collaborator-display.util';
import {
  IntegrationAmbiguousSignerException,
  IntegrationSignerNotFoundException,
} from '../exceptions/integration-document.exceptions';

/**
 * Localiza al firmante de un documento por su correo, sin distinguir mayúsculas ni espacios
 * alrededor. El correo sólo localiza: no autoriza nada.
 *
 * @param signers - Firmantes del documento.
 * @param email - Correo recibido en la petición.
 * @returns El único firmante con ese correo.
 *
 * @throws {IntegrationSignerNotFoundException} (404) Si ningún firmante tiene ese correo.
 * @throws {IntegrationAmbiguousSignerException} (409) Si más de un firmante tiene ese correo.
 *
 * @example
 * ```ts
 * const collaborator = findSignerByEmail(signers, ' Ana@Correo.com ');
 * ```
 */
export function findSignerByEmail(
  signers: CollaboratorEntity[],
  email: string,
): CollaboratorEntity {
  const normalized = email.trim().toLowerCase();
  const matches = signers.filter(
    (signer) => collaboratorEmail(signer).toLowerCase() === normalized,
  );

  if (matches.length === 0) throw new IntegrationSignerNotFoundException();
  if (matches.length > 1) throw new IntegrationAmbiguousSignerException();
  return matches[0];
}
