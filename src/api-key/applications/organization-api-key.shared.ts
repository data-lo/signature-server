import { EntityManager } from 'typeorm';

import { AuthorizationContext } from 'src/authorization/interfaces/authorization-context.interface';
import { PermissionEntity } from 'src/roles/entities/permission.entity';
import {
  buildPermissionKey,
  comparePermissionKeys,
} from 'src/roles/permission-catalog.util';

import { isApiKeyAssignablePermission } from '../api-key-permission-policy';
import { ApiKeySecretService } from '../api-key-secret.service';
import { ApiKeyService } from '../api-key.service';
import { ApiKeyEntity } from '../entities/api-key.entity';
import { ApiKeyStatusEnum } from '../enums/api-key-status.enum';
import {
  ApiKeyInvalidExpirationException,
  ApiKeyOrganizationNotFoundException,
  ApiKeyPermissionNotAllowedException,
  ApiKeyPermissionNotFoundException,
} from '../exceptions/api-key.exceptions';
import {
  IssuedOrganizationApiKeyData,
  OrganizationApiKeyData,
} from '../interfaces/response/organization-api-key-response';

/** Quién opera y sobre qué organización: lo que resolvió `PermissionsGuard` más la ruta. */
export interface OrganizationApiKeyActor {
  /** `:organizationId` de la ruta; el guard ya validó la membresía en ella. */
  organizationId: string;

  /** Contexto autorizado; su `accountId` es la membresía en esa organización. */
  authorization: AuthorizationContext;
}

/**
 * Proyecta una llave a su respuesta pública: sin secreto ni hash.
 *
 * @param apiKey - Llave con `permissions` (y su recurso y acción) cargados.
 * @returns Los metadatos de la llave, con los permisos en el orden del catálogo.
 *
 * @throws {TypeError} Si la llave llega sin `permissions` cargados.
 *
 * @example
 * ```ts
 * toOrganizationApiKeyData(apiKey); // { id, name, prefix, status, permissions: [{ id, key }], … }
 * ```
 */
export function toOrganizationApiKeyData(
  apiKey: ApiKeyEntity,
): OrganizationApiKeyData {
  if (!apiKey.permissions) {
    throw new TypeError(`La API key ${apiKey.id} llegó sin permisos cargados`);
  }

  return {
    id: apiKey.id,
    name: apiKey.name,
    prefix: apiKey.keyPrefix,
    status: apiKey.status,
    permissions: apiKey.permissions
      .map((permission) => ({
        id: permission.id,
        key: toPermissionKey(permission),
      }))
      .sort((first, second) => comparePermissionKeys(first.key, second.key)),
    createdAt: apiKey.createdAt,
    lastUsedAt: apiKey.lastUsedAt,
    expiresAt: apiKey.expiresAt,
    revokedAt: apiKey.revokedAt,
    createdByAccountId: apiKey.createdByAccountId,
    revokedByAccountId: apiKey.revokedByAccountId,
  };
}

/**
 * Comprueba que la organización de la ruta exista y esté activa.
 *
 * @param apiKeyService - Acceso a datos.
 * @param organizationId - Organización de la ruta.
 * @returns Nada.
 *
 * @throws {ApiKeyOrganizationNotFoundException} (404) Si no existe o está desactivada.
 *
 * @example
 * ```ts
 * await assertActiveOrganization(apiKeyService, 'org-1');
 * ```
 */
export async function assertActiveOrganization(
  apiKeyService: ApiKeyService,
  organizationId: string,
): Promise<void> {
  if (!(await apiKeyService.findActiveOrganization(organizationId))) {
    throw new ApiKeyOrganizationNotFoundException();
  }
}

/**
 * Convierte el `expiresAt` del body en fecha y exige que sea futura.
 *
 * @param expiresAt - Fecha ISO 8601 ya validada por el DTO, o `null`/omitida.
 * @param now - Momento de la petición.
 * @returns La fecha, o `null` si la llave no vence.
 *
 * @throws {ApiKeyInvalidExpirationException} (422) Si no es posterior a `now`.
 *
 * @example
 * ```ts
 * parseExpiresAt('2027-10-26T00:00:00.000Z', new Date()); // Date
 * parseExpiresAt(undefined, new Date()); // null
 * ```
 */
export function parseExpiresAt(
  expiresAt: string | null | undefined,
  now: Date,
): Date | null {
  if (expiresAt === undefined || expiresAt === null) {
    return null;
  }

  const date = new Date(expiresAt);

  if (Number.isNaN(date.getTime()) || date.getTime() <= now.getTime()) {
    throw new ApiKeyInvalidExpirationException();
  }

  return date;
}

/**
 * Carga los permisos pedidos y exige que todos existan y sean asignables a una API key.
 *
 * @param apiKeyService - Acceso a datos.
 * @param permissionIds - Ids pedidos; los repetidos cuentan una vez.
 * @returns Los permisos, con recurso y acción cargados.
 *
 * @throws {ApiKeyPermissionNotFoundException} (422) Si alguno no existe.
 * @throws {ApiKeyPermissionNotAllowedException} (422) Si alguno no está en la política de
 *   `api-key-permission-policy.ts`.
 *
 * @example
 * ```ts
 * const permissions = await resolveAssignablePermissions(apiKeyService, ['perm-1']);
 * ```
 */
export async function resolveAssignablePermissions(
  apiKeyService: ApiKeyService,
  permissionIds: string[],
): Promise<PermissionEntity[]> {
  const uniqueIds = [...new Set(permissionIds)];
  const permissions = await apiKeyService.findPermissionsByIds(uniqueIds);

  const foundIds = new Set(permissions.map((permission) => permission.id));
  const missingIds = uniqueIds.filter((id) => !foundIds.has(id));
  if (missingIds.length > 0) {
    throw new ApiKeyPermissionNotFoundException(missingIds);
  }

  const forbiddenKeys = permissions
    .map(toPermissionKey)
    .filter((key) => !isApiKeyAssignablePermission(key));
  if (forbiddenKeys.length > 0) {
    throw new ApiKeyPermissionNotAllowedException(forbiddenKeys);
  }

  return permissions;
}

/** Datos de la llave a emitir que decide el caso de uso. */
export interface IssueApiKeyParams {
  organizationId: string;
  /** Membresía que la emite; `null` para una llave emitida por la plataforma. */
  createdByAccountId: string | null;
  name: string;
  permissions: PermissionEntity[];
  expiresAt: Date | null;
}

/**
 * Emite una llave `ACTIVE` dentro de la transacción del llamador: genera el secreto, guarda sólo
 * su hash y asigna los permisos.
 *
 * No comprueba que la organización no tenga ya una llave activa: eso lo hace el llamador con la
 * organización bloqueada, y el índice único parcial de la base es la protección final.
 *
 * @param manager - Transacción en curso.
 * @param apiKeyService - Acceso a datos.
 * @param apiKeySecretService - Generación y hash del secreto.
 * @param params - Organización, autor, nombre, permisos y expiración.
 * @returns Los metadatos de la llave más la llave completa, que sólo se entrega aquí.
 *
 * @throws {ApiKeyNotConfiguredException} (500) Si falta `API_KEY_PEPPER`.
 * @throws {QueryFailedError} Si la base rechaza la fila (p. ej. una segunda llave activa).
 *
 * @example
 * ```ts
 * const issued = await issueApiKey(manager, apiKeyService, apiKeySecretService, {
 *   organizationId: 'org-1', createdByAccountId: 'acc-1', name: 'ERP', permissions, expiresAt: null,
 * });
 * issued.key; // 'fma_live_…'
 * ```
 */
export async function issueApiKey(
  manager: EntityManager,
  apiKeyService: ApiKeyService,
  apiKeySecretService: ApiKeySecretService,
  params: IssueApiKeyParams,
): Promise<IssuedOrganizationApiKeyData> {
  const { publicId, keyPrefix, key, secretHash } =
    apiKeySecretService.generate();

  const saved = await apiKeyService.insertApiKey(
    manager,
    manager.create(ApiKeyEntity, {
      organizationId: params.organizationId,
      createdByAccountId: params.createdByAccountId,
      publicId,
      keyPrefix,
      secretHash,
      name: params.name,
      status: ApiKeyStatusEnum.ACTIVE,
      expiresAt: params.expiresAt,
      lastUsedAt: null,
      revokedAt: null,
      revokedByAccountId: null,
      permissions: params.permissions,
    }),
  );

  return { ...toOrganizationApiKeyData(saved), key };
}

function toPermissionKey(permission: PermissionEntity): string {
  return buildPermissionKey(
    permission.resource.key,
    permission.action.key,
    permission.scope,
  );
}
