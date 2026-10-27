import { SetMetadata } from '@nestjs/common';

import { ACTION_KEY_ENUM } from 'src/roles/enums/action-key.enum';
import { PERMISSION_SCOPE_ENUM } from 'src/roles/enums/permission-scope.enum';
import { RESOURCE_KEY_ENUM } from 'src/roles/enums/resource-key.enum';

export const REQUIRED_API_KEY_PERMISSION_METADATA = 'requiredApiKeyPermission';

/** Lo que un endpoint de integración exige de la llave. */
export interface RequiredApiKeyPermission {
  resource: RESOURCE_KEY_ENUM;
  action: ACTION_KEY_ENUM;
  /**
   * Alcances que aceptan el endpoint; basta con que la llave tenga uno. `ANY` en la llave
   * ("sin distinción de alcance", como `DOCUMENT.CREATE` del catálogo) satisface cualquiera.
   */
  scopes: PERMISSION_SCOPE_ENUM[];
}

/**
 * Declara el permiso que un endpoint de integración exige a la API key, con recurso, acción y
 * alcances aceptados. Lo hace cumplir `OrganizationApiKeyGuard`.
 *
 * A diferencia de `@RequirePermission` (miembros con JWT), aquí el alcance SÍ se declara: una
 * llave no tiene rol que lo decida, y el endpoint es quien sabe si le alcanza con `OWN`.
 *
 * @param resource - Recurso sobre el que actúa el endpoint.
 * @param action - Acción que ejerce sobre él.
 * @param scopes - Alcances aceptados; con uno que tenga la llave, pasa.
 * @returns El decorador con el metadato ya fijado.
 *
 * @example
 * ```ts
 * @RequireApiKeyPermission(RESOURCE_KEY_ENUM.DOCUMENT, ACTION_KEY_ENUM.READ, [PERMISSION_SCOPE_ENUM.ORGANIZATION])
 * ```
 */
export const RequireApiKeyPermission = (
  resource: RESOURCE_KEY_ENUM,
  action: ACTION_KEY_ENUM,
  scopes: PERMISSION_SCOPE_ENUM[],
) =>
  SetMetadata(REQUIRED_API_KEY_PERMISSION_METADATA, {
    resource,
    action,
    scopes,
  } satisfies RequiredApiKeyPermission);
