import { ACTION_KEY_ENUM } from './enums/action-key.enum';
import { PERMISSION_SCOPE_ENUM } from './enums/permission-scope.enum';
import { RESOURCE_KEY_ENUM } from './enums/resource-key.enum';
import {
  STATIC_PERMISSION_CATALOG,
  STATIC_PERMISSION_KEY_ENUM,
} from './static-permission-catalog';

/**
 * Lo que una cuenta PERSONAL puede hacer, derivado del catálogo estático y NO de su rol.
 *
 * Una cuenta personal es una persona sobre lo suyo: su plan, sus pagos y sus documentos. No hay
 * nadie a quien invitar, ningún rol que repartir y ninguna organización que administrar, así que
 * pasarla por `role_permissions` no aporta nada y sí quita:
 *
 * - **Las cuentas personales nacen con el rol de sistema OWNER** (ver
 *   `AccountService.createDefaultPersonalAccount`), que trae el catálogo COMPLETO. Resolver sus
 *   permisos por rol le regala `ORGANIZATION.*`, `MEMBER.*`, `ROLE.*` y
 *   `DOCUMENT.READ_ORGANIZATION` sobre una organización que no existe, y con ellos un menú con
 *   "Administrar miembros" y "Roles y permisos" que no llevan a ninguna parte.
 * - **Las cuentas personales viejas pueden no tener rol.** `accounts.role_id` es nullable y hubo
 *   altas que lo dejaron en NULL; por rol, esas cuentas resuelven la lista vacía y no pueden ni
 *   ver su propio plan. Derivar del catálogo las deja funcionando sin depender del dato.
 *
 * El recorte es una función del catálogo, no una lista escrita a mano: `organizationOnly` es
 * obligatorio en cada definición, así que un permiso nuevo ligado a una organización queda fuera
 * de aquí en cuanto se declara, y uno nuevo que sí sea de la persona entra solo.
 *
 * **Las cuentas ORGANIZATION no tocan nada de este archivo.** Siguen resolviendo contra
 * `role_permissions`, con los permisos exactos que les dé su rol.
 */
export const PERSONAL_ACCOUNT_PERMISSION_KEYS: readonly STATIC_PERMISSION_KEY_ENUM[] =
  Object.freeze(
    (
      Object.entries(STATIC_PERMISSION_CATALOG) as [
        STATIC_PERMISSION_KEY_ENUM,
        (typeof STATIC_PERMISSION_CATALOG)[STATIC_PERMISSION_KEY_ENUM],
      ][]
    )
      .filter(([, definition]) => !definition.organizationOnly)
      .map(([key]) => key),
  );

/**
 * Indica si una cuenta PERSONAL tiene concedida esa clave del catálogo.
 *
 * @param key - Clave del catálogo estático.
 * @returns `true` si la clave no está ligada a una organización.
 *
 * @throws Nada: es una consulta sobre una constante en memoria.
 *
 * @example
 * ```ts
 * isPersonalAccountPermission(STATIC_PERMISSION_KEY_ENUM.BILLING_MANAGE); // true
 * isPersonalAccountPermission(STATIC_PERMISSION_KEY_ENUM.MEMBER_READ); // false
 * ```
 */
export function isPersonalAccountPermission(
  key: STATIC_PERMISSION_KEY_ENUM,
): boolean {
  return PERSONAL_ACCOUNT_PERMISSION_KEYS.includes(key);
}

/**
 * Alcances con los que una cuenta PERSONAL ejerce un `resource + action`.
 *
 * Es el equivalente de `RolesService.getPermissionScopes` para el contexto personal, y devuelve
 * lo mismo que aquél: una lista de alcances, vacía cuando no hay permiso. Que sean varios no es
 * teórico —`DOCUMENT + READ` existe como `OWN` y como `ORGANIZATION`— y por eso el recorte se
 * aplica antes de quedarse con los alcances: una cuenta personal que leyera `DOCUMENT + READ`
 * sin filtrar se llevaría también el alcance de toda la organización.
 *
 * @param resource - Recurso declarado por el endpoint.
 * @param action - Acción declarada por el endpoint.
 * @returns Los alcances concedidos, sin repetidos y en el orden del catálogo.
 *
 * @throws Nada: no consulta la base, sólo el catálogo en memoria.
 *
 * @example
 * ```ts
 * getPersonalAccountPermissionScopes(
 *   RESOURCE_KEY_ENUM.DOCUMENT,
 *   ACTION_KEY_ENUM.READ,
 * ); // ['OWN'] — nunca 'ORGANIZATION'
 *
 * getPersonalAccountPermissionScopes(
 *   RESOURCE_KEY_ENUM.MEMBER,
 *   ACTION_KEY_ENUM.READ,
 * ); // []
 * ```
 */
export function getPersonalAccountPermissionScopes(
  resource: RESOURCE_KEY_ENUM,
  action: ACTION_KEY_ENUM,
): PERMISSION_SCOPE_ENUM[] {
  const scopes = PERSONAL_ACCOUNT_PERMISSION_KEYS.map(
    (key) => STATIC_PERMISSION_CATALOG[key],
  )
    .filter(
      (definition) =>
        definition.resource === resource && definition.action === action,
    )
    .map((definition) => definition.scope);

  return [...new Set(scopes)];
}
