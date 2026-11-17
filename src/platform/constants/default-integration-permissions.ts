import { STATIC_PERMISSION_KEY_ENUM } from 'src/roles/static-permission-catalog';

/**
 * Perfil de permisos con el que el aprovisionamiento interno emite la API key: todo lo que una
 * integración puede hacer sobre los documentos y el directorio de su organización, y nada más.
 *
 * Lo decide el backend, no el operador: el request no lleva `permissionIds`. Es un subconjunto de
 * la lista blanca `API_KEY_ASSIGNABLE_PERMISSION_KEYS` (una prueba lo verifica) y deja fuera:
 * - todo lo administrativo (`ORGANIZATION.*`, `MEMBER.*`, `ROLE.*`, `BILLING.*`, `USER.*`,
 *   `API_KEY.*`), que la lista blanca ya excluye;
 * - `DOCUMENT.READ_OWN`: con `DOCUMENT.READ_ORGANIZATION` sobra, y una llave de plataforma no
 *   tiene actor cuyos documentos "propios" leer.
 */
export const DEFAULT_INTEGRATION_PERMISSION_KEYS: readonly string[] = [
  STATIC_PERMISSION_KEY_ENUM.DOCUMENT_CREATE,
  STATIC_PERMISSION_KEY_ENUM.DOCUMENT_READ_ORGANIZATION,
  STATIC_PERMISSION_KEY_ENUM.DOCUMENT_SEND_SIGNATURE_REQUEST,
  STATIC_PERMISSION_KEY_ENUM.DOCUMENT_CANCEL,
  STATIC_PERMISSION_KEY_ENUM.DIRECTORY_READ,
  STATIC_PERMISSION_KEY_ENUM.DIRECTORY_CREATE,
  STATIC_PERMISSION_KEY_ENUM.DIRECTORY_UPDATE,
  STATIC_PERMISSION_KEY_ENUM.DIRECTORY_DELETE,
];
