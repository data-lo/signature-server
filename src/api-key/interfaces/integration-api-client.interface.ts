import { ACTION_KEY_ENUM } from 'src/roles/enums/action-key.enum';
import { PERMISSION_SCOPE_ENUM } from 'src/roles/enums/permission-scope.enum';
import { RESOURCE_KEY_ENUM } from 'src/roles/enums/resource-key.enum';

/** Un permiso concedido a la llave, tal como sale de `api_key_permissions` → `permissions`. */
export interface IntegrationApiClientPermission {
  resource: RESOURCE_KEY_ENUM;
  action: ACTION_KEY_ENUM;
  scope: PERMISSION_SCOPE_ENUM;
}

/**
 * Quién llama a la API de integración, resuelto por `OrganizationApiKeyGuard` a partir de la
 * llave y nada más: ni JWT, ni `X-Account-Id`, ni una organización en la URL o el body.
 *
 * `OrganizationApiKeyGuard` lo deja en `request.apiClient` y lo entrega `@CurrentApiClient()`. Es
 * el contexto ya validado: la llave está activa y vigente, la organización está activa y el actor
 * sigue siendo miembro activo de ella. Nunca lleva el secreto ni su hash.
 */
export interface IntegrationApiClient {
  /** `api_keys.id` de la llave autenticada. */
  apiKeyId: string;

  /** Nombre administrativo de la llave ("Integración ERP"), para la trazabilidad. */
  apiKeyName: string;

  /** Organización de la llave: el único tenant sobre el que puede operar. */
  organizationId: string;

  /** Membresía (`accounts.id`) que emitió la llave: en su nombre se actúa. */
  actorAccountId: string;

  /** Usuario (`users.id`) dueño de esa membresía. */
  actorUserId: string;

  /** Permisos concedidos a la llave, con su alcance. */
  permissions: IntegrationApiClientPermission[];
}
