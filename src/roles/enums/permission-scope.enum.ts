/**
 * Alcance de una Permission: sobre QUÉ instancias del recurso aplica la acción.
 *
 * La columna es varchar (no un enum a nivel de base), así que agregar valores nuevos no
 * necesita migración. Ojo: `RolesService.hasPermission` hoy consulta por resource+action e
 * **ignora el scope**, así que quien quiera distinguir OWN de ORGANIZATION tendrá que hacer la
 * consulta sensible al scope — parte del ticket de RBAC efectivo, no de la carga del catálogo.
 */
export enum PERMISSION_SCOPE_ENUM {
  /** Sin distinción de alcance: la acción no se acota a un subconjunto de instancias. */
  ANY = 'ANY',
  /** Sólo los recursos propios o en los que el miembro participa (p. ej. como firmante). */
  OWN = 'OWN',
  /** Todos los recursos de la organización activa. */
  ORGANIZATION = 'ORGANIZATION',
  /** Sólo en nombre propio: el miembro se afecta a sí mismo, no a terceros. */
  SELF = 'SELF',
}
