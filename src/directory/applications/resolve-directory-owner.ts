import { BadRequestException, ForbiddenException } from '@nestjs/common';

import { DirectoryOwner } from '../interfaces/directory-data';
import { DirectoryActor } from '../interfaces/request/directory-contact-request';

/**
 * Resuelve el dueño del directorio a partir de la membresía autorizada.
 *
 * El directorio NUNCA lo elige el cliente. Una cuenta PERSONAL usa el directorio de su
 * `accounts.id`; una de ORGANIZATION, el de su `organizationId`, el mismo para todos los
 * miembros. `X-Account-Id` es obligatorio y tiene que ser la misma membresía que autorizó
 * `PermissionsGuard`: el guard da prioridad a `X-Organization-Id` cuando llega, así que sin esta
 * comprobación un cliente podría autorizarse con una organización y nombrar otra cuenta en
 * `X-Account-Id`.
 *
 * @param actor - Contexto autorizado y header `X-Account-Id` de la petición.
 * @returns La cuenta personal o la organización dueña del directorio.
 *
 * @throws {BadRequestException} (400) Si falta `X-Account-Id`.
 * @throws {ForbiddenException} (403) Si `X-Account-Id` no es la membresía autorizada.
 *
 * @example
 * ```ts
 * resolveDirectoryOwner({ authorization: personalAuthorization, activeAccountId: 'acc-1' });
 * // { personalAccountId: 'acc-1', organizationId: null }
 * ```
 */
export function resolveDirectoryOwner({
  authorization,
  activeAccountId,
}: DirectoryActor): DirectoryOwner {
  if (!activeAccountId) {
    throw new BadRequestException(
      'Falta el header X-Account-Id de la cuenta activa',
    );
  }
  if (activeAccountId !== authorization.accountId) {
    throw new ForbiddenException(
      'X-Account-Id no corresponde a la cuenta autorizada',
    );
  }

  return authorization.organizationId
    ? { personalAccountId: null, organizationId: authorization.organizationId }
    : { personalAccountId: authorization.accountId, organizationId: null };
}
