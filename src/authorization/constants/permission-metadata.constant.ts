/**
 * Clave con la que `@RequirePermission` guarda el permiso exigido por un endpoint y con la que
 * `PermissionsGuard` lo vuelve a leer desde el `Reflector`.
 *
 * Vive en su propio archivo, y no junto al decorador, para que el guard no tenga que importar el
 * decorador sólo para conocer la clave: son los dos extremos del mismo metadato y ninguno de los
 * dos debería depender del otro.
 */
export const REQUIRED_PERMISSION_METADATA = 'authorization:required-permission';
