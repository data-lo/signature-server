import { ActionEntity } from './entities/action.entity';
import { PermissionEntity } from './entities/permission.entity';
import { ResourceEntity } from './entities/resource.entity';
import { PERMISSION_SCOPE_ENUM } from './enums/permission-scope.enum';
import { RolePermissionData } from './interfaces/response/permission-response';

/**
 * Traduce una fila de `permissions` a la forma en que el frontend la muestra: una clave estable
 * y una descripción en lenguaje de negocio.
 *
 * La clave se DERIVA de la fila (`resource.key`, `action.key`, `scope`) en vez de guardarse en
 * la base: `permissions` no tiene columna de clave ni de descripción, y agregarlas sería un
 * cambio de esquema para algo que sólo se lee en la UI de administración de miembros.
 *
 * El diccionario de abajo cubre el catálogo de permisos estáticos de organización; cualquier
 * otra fila —la rejilla CRUD que sembró `npm run seed:roles`, o un permiso que una organización
 * agregue en el futuro— se describe con el texto genérico de su recurso y su acción, para que la
 * pantalla nunca muestre un hueco.
 */

/** Descripciones de negocio del catálogo estático, por clave derivada. */
const STATIC_PERMISSION_DESCRIPTIONS: Record<string, string> = {
  'DOCUMENT.CREATE':
    'Crear documentos o borradores dentro de la organización activa.',
  'DOCUMENT.READ_OWN':
    'Consultar documentos propios o donde el miembro sea firmante.',
  'DOCUMENT.READ_ORGANIZATION': 'Consultar documentos de toda la organización.',
  'DOCUMENT.SEND_SIGNATURE_REQUEST':
    'Enviar solicitudes de firma de documentos autorizados.',
  'DOCUMENT.SIGN_SELF': 'Firmar en nombre propio e incluirse como firmante.',
  'DOCUMENT.APPROVE':
    'Aprobar o autorizar documentos cuando el flujo existente lo soporte.',
  'MEMBER.INVITE': 'Invitar miembros a la organización activa.',
};

/**
 * Orden en que la UI lista el catálogo estático. Los permisos que no son del catálogo van
 * después, en el orden en que llegan de la base.
 */
const STATIC_PERMISSION_ORDER = Object.keys(STATIC_PERMISSION_DESCRIPTIONS);

/**
 * Construye la clave estable de un permiso a partir de su recurso, su acción y su alcance.
 *
 * El alcance `ANY` no se escribe: es "sin distinción de alcance", y arrastrarlo a la clave
 * (`DOCUMENT.CREATE_ANY`) sólo la haría más ruidosa. Cualquier otro alcance sí se sufija, que es
 * lo que separa `DOCUMENT.READ_OWN` de `DOCUMENT.READ_ORGANIZATION`.
 *
 * @param resourceKey - Clave del recurso (`DOCUMENT`, `MEMBER`, `ORGANIZATION`...).
 * @param actionKey - Clave de la acción (`CREATE`, `READ`, `SIGN`...).
 * @param scope - Alcance guardado en `permissions.scope`.
 * @returns La clave en formato `RECURSO.ACCION` o `RECURSO.ACCION_ALCANCE`.
 *
 * @example
 * ```ts
 * buildPermissionKey('DOCUMENT', 'READ', 'OWN'); // 'DOCUMENT.READ_OWN'
 * buildPermissionKey('DOCUMENT', 'CREATE', 'ANY'); // 'DOCUMENT.CREATE'
 * ```
 */
export function buildPermissionKey(
  resourceKey: string,
  actionKey: string,
  scope: string,
): string {
  const base = `${resourceKey}.${actionKey}`;

  return scope === PERMISSION_SCOPE_ENUM.ANY ? base : `${base}_${scope}`;
}

/**
 * Descripción legible de un permiso: la del catálogo estático si la clave pertenece a él, y si
 * no, una armada con los textos genéricos del recurso y la acción.
 *
 * @param key - Clave derivada del permiso (ver `buildPermissionKey`).
 * @param resource - Recurso al que apunta el permiso.
 * @param action - Acción a la que apunta el permiso.
 * @returns Una frase en español, nunca vacía.
 *
 * @example
 * ```ts
 * describePermission('DOCUMENT.SIGN_SELF', documentResource, signAction);
 * // 'Firmar en nombre propio e incluirse como firmante.'
 * ```
 */
export function describePermission(
  key: string,
  resource: ResourceEntity,
  action: ActionEntity,
): string {
  return (
    STATIC_PERMISSION_DESCRIPTIONS[key] ??
    `${action.description} — ${resource.description}`
  );
}

/**
 * Ordena los permisos dejando primero el catálogo estático, en el orden en que lo documenta la
 * historia, y después el resto tal como vino de la base.
 *
 * @param keys - Claves de los dos permisos a comparar, en el orden en que se reciben.
 * @returns Un comparador apto para `Array.prototype.sort`.
 *
 * @example
 * ```ts
 * permissions.sort((a, b) => comparePermissionKeys(a.key, b.key));
 * ```
 */
export function comparePermissionKeys(
  firstKey: string,
  secondKey: string,
): number {
  const first = STATIC_PERMISSION_ORDER.indexOf(firstKey);
  const second = STATIC_PERMISSION_ORDER.indexOf(secondKey);

  if (first === -1 && second === -1) return firstKey.localeCompare(secondKey);
  if (first === -1) return 1;
  if (second === -1) return -1;

  return first - second;
}

/**
 * Indica si la clave pertenece al catálogo de permisos estáticos de organización.
 *
 * La UI lo usa para separar lo que la historia llama "capacidades" de la rejilla CRUD heredada
 * del seed anterior, que sigue existiendo en la base y no debe presentarse igual.
 *
 * @param key - Clave derivada del permiso.
 * @returns `true` si es uno de los siete permisos del catálogo.
 *
 * @example
 * ```ts
 * isStaticCatalogPermission('DOCUMENT.APPROVE'); // true
 * isStaticCatalogPermission('USER.DELETE'); // false
 * ```
 */
export function isStaticCatalogPermission(key: string): boolean {
  return key in STATIC_PERMISSION_DESCRIPTIONS;
}

/**
 * Proyecta una fila de `permissions` (con su recurso y su acción ya cargados) al shape que
 * consumen la API y el frontend.
 *
 * @param permission - Permiso con las relaciones `resource` y `action` resueltas.
 * @returns Clave, recurso, acción, alcance, descripción y si es del catálogo estático.
 *
 * @throws {TypeError} Si el permiso llega sin `resource` o sin `action` cargados.
 *
 * @example
 * ```ts
 * const data = toPermissionData(permission);
 * // { id: '…', key: 'DOCUMENT.READ_OWN', resource: 'DOCUMENT', action: 'READ', scope: 'OWN', … }
 * ```
 */
export function toPermissionData(
  permission: PermissionEntity,
): RolePermissionData {
  const { resource, action } = permission;

  if (!resource || !action) {
    throw new TypeError(
      `El permiso ${permission.id} llegó sin resource/action cargados`,
    );
  }

  const key = buildPermissionKey(resource.key, action.key, permission.scope);

  return {
    id: permission.id,
    key,
    resource: resource.key,
    action: action.key,
    scope: permission.scope,
    description: describePermission(key, resource, action),
    isStaticCatalog: isStaticCatalogPermission(key),
  };
}
