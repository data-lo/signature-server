import { RESOURCE_KEY_ENUM } from 'src/roles/enums/resource-key.enum';
import { STATIC_PERMISSION_KEY_ENUM } from 'src/roles/static-permission-catalog';

/**
 * Qué permisos del catálogo se le pueden conceder a una API key.
 *
 * Es una lista BLANCA, y a propósito: un permiso nuevo del catálogo no queda expuesto a las
 * integraciones hasta que alguien lo agregue aquí. Una lista negra fallaría al revés, regalando
 * cualquier capacidad futura.
 *
 * Entra lo que una integración hace sobre los documentos y el directorio de la organización.
 * Quedan fuera, además de todo lo administrativo (ver `API_KEY_FORBIDDEN_RESOURCES`):
 * - `DOCUMENT.SIGN_SELF`: firmar es un acto de una persona identificada; una llave no lo es.
 * - `DOCUMENT.APPROVE`: el flujo de aprobación exige un aprobador miembro de la organización.
 */
export const API_KEY_ASSIGNABLE_PERMISSION_KEYS: ReadonlySet<string> =
  new Set<string>([
    STATIC_PERMISSION_KEY_ENUM.DOCUMENT_CREATE,
    STATIC_PERMISSION_KEY_ENUM.DOCUMENT_READ_OWN,
    STATIC_PERMISSION_KEY_ENUM.DOCUMENT_READ_ORGANIZATION,
    STATIC_PERMISSION_KEY_ENUM.DOCUMENT_SEND_SIGNATURE_REQUEST,
    STATIC_PERMISSION_KEY_ENUM.DOCUMENT_CANCEL,
    STATIC_PERMISSION_KEY_ENUM.DIRECTORY_READ,
    STATIC_PERMISSION_KEY_ENUM.DIRECTORY_CREATE,
    STATIC_PERMISSION_KEY_ENUM.DIRECTORY_UPDATE,
    STATIC_PERMISSION_KEY_ENUM.DIRECTORY_DELETE,
  ]);

/**
 * Recursos que una API key nunca puede administrar: la organización, sus miembros y roles, la
 * facturación, los usuarios y las propias API keys.
 *
 * No decide nada por sí misma —la lista blanca ya los excluye—: es la red de seguridad que una
 * prueba compara contra `API_KEY_ASSIGNABLE_PERMISSION_KEYS`, para que agregar ahí un permiso
 * administrativo por error falle en CI y no en producción.
 */
export const API_KEY_FORBIDDEN_RESOURCES: ReadonlySet<string> = new Set<string>(
  [
    RESOURCE_KEY_ENUM.ORGANIZATION,
    RESOURCE_KEY_ENUM.MEMBER,
    RESOURCE_KEY_ENUM.ROLE,
    RESOURCE_KEY_ENUM.BILLING,
    RESOURCE_KEY_ENUM.USER,
    RESOURCE_KEY_ENUM.API_KEY,
  ],
);

/**
 * Indica si un permiso, identificado por su clave derivada, se le puede conceder a una API key.
 *
 * @param permissionKey - Clave `RECURSO.ACCION[_ALCANCE]` (ver `buildPermissionKey`).
 * @returns `true` si está en la lista blanca y su recurso no es administrativo.
 *
 * @example
 * ```ts
 * isApiKeyAssignablePermission('DOCUMENT.CREATE'); // true
 * isApiKeyAssignablePermission('MEMBER.INVITE'); // false
 * ```
 */
export function isApiKeyAssignablePermission(permissionKey: string): boolean {
  const [resource] = permissionKey.split('.');

  return (
    API_KEY_ASSIGNABLE_PERMISSION_KEYS.has(permissionKey) &&
    !API_KEY_FORBIDDEN_RESOURCES.has(resource)
  );
}
