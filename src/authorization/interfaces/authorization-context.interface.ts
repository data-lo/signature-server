import { ACTION_KEY_ENUM } from '../../roles/enums/action-key.enum';
import { PERMISSION_SCOPE_ENUM } from '../../roles/enums/permission-scope.enum';
import { RESOURCE_KEY_ENUM } from '../../roles/enums/resource-key.enum';

/**
 * El resultado de autorizar una petición: quién la hace, desde qué cuenta activa, con qué rol, y
 * hasta dónde alcanza el permiso que se le concedió.
 *
 * `PermissionsGuard` lo arma una sola vez por petición y lo deja en `request.authorization`; de
 * ahí lo toma `@CurrentAuthorization()` y lo recibe el caso de uso. Nadie más vuelve a resolver
 * la membresía: es el contexto ya validado, no una pista para volver a comprobar.
 *
 * `organizationId` es `null` cuando la cuenta activa es PERSONAL. No es un caso degradado: una
 * cuenta personal también pasa por aquí, y su dueño es el único que puede actuar sobre ella. Una
 * Policy que compare organizaciones tiene que contar con el `null` — ver
 * `DocumentAuthorizationPolicy`.
 *
 * `roleId` también puede llegar `null`, y sólo en ese mismo caso: los permisos de una cuenta
 * PERSONAL salen del catálogo y no de su rol (ver `personal-account-permissions.ts`), así que
 * tener rol dejó de ser condición para autorizarla. En una cuenta de organización siempre viene
 * informado, porque ahí sin rol no hay permisos.
 */
export interface AuthorizationContext {
  /** Usuario autenticado (`JwtPayload.sub`). */
  userId: string;

  /** Organización activa, o `null` si la cuenta activa es PERSONAL. */
  organizationId: string | null;

  /** Fila de `accounts`: la membresía concreta desde la que actúa el usuario. */
  accountId: string;

  /**
   * Rol de esa membresía. `null` en una cuenta PERSONAL sin rol asignado: sus scopes no salieron
   * de un rol sino del catálogo.
   */
  roleId: string | null;

  /** Recurso que declaró el endpoint. */
  resource: RESOURCE_KEY_ENUM;

  /** Acción que declaró el endpoint. */
  action: ACTION_KEY_ENUM;

  /**
   * Alcances concedidos para ese `resource + action`. Nunca vacío: si no hubiera ninguno, la
   * autorización habría fallado con 403 antes de construir el contexto.
   */
  scopes: PERMISSION_SCOPE_ENUM[];
}
