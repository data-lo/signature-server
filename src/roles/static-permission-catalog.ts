import { ACTION_KEY_ENUM } from './enums/action-key.enum';
import { PERMISSION_SCOPE_ENUM } from './enums/permission-scope.enum';
import { RESOURCE_KEY_ENUM } from './enums/resource-key.enum';
import { SYSTEM_ROLE_NAME_ENUM } from './enums/system-role-name.enum';

/**
 * Catálogo de permisos ESTÁTICOS de organización: la lista cerrada de cosas que una membresía
 * con `organizationId` podrá hacer, y qué rol de sistema trae cada una de fábrica.
 *
 * Es la única fuente de verdad del catálogo. `npm run seed:static-permissions` lo materializa en
 * `resources`/`actions`/`permissions`/`role_permissions`, y el futuro RBAC efectivo leerá de aquí
 * las claves con las que proteger endpoints — por eso vive en `src/roles/` y no en `src/scripts/`.
 *
 * Tres cosas que NO son este catálogo:
 *
 * - **`organization_permissions`.** Es un sistema paralelo de nombres libres que cada ADMIN
 *   define para su organización ("puede aprobar gastos"); no otorga acceso técnico a nada y no
 *   se toca desde aquí.
 * - **Las cuentas personales.** El catálogo se usará sólo al autorizar membresías con
 *   `organizationId`; una cuenta PERSONAL no pasa por él.
 * - **La descripción en base de datos.** `permissions` no tiene columna `description` y este
 *   catálogo no agrega una: la descripción de cada permiso vive acá, en código, porque
 *   persistirla exigiría una migración de esquema para un texto que sólo se lee en la consola
 *   del seed y en esta documentación.
 */

/** Clave estable de cada permiso del catálogo, en formato `RECURSO.ACCION[_ALCANCE]`. */
export enum STATIC_PERMISSION_KEY_ENUM {
  DOCUMENT_CREATE = 'DOCUMENT.CREATE',
  DOCUMENT_READ_OWN = 'DOCUMENT.READ_OWN',
  DOCUMENT_READ_ORGANIZATION = 'DOCUMENT.READ_ORGANIZATION',
  DOCUMENT_SEND_SIGNATURE_REQUEST = 'DOCUMENT.SEND_SIGNATURE_REQUEST',
  DOCUMENT_SIGN_SELF = 'DOCUMENT.SIGN_SELF',
  DOCUMENT_APPROVE = 'DOCUMENT.APPROVE',
  MEMBER_INVITE = 'MEMBER.INVITE',
}

/** Cómo se materializa una clave del catálogo en una fila de `permissions`. */
export interface StaticPermissionDefinition {
  resource: RESOURCE_KEY_ENUM;
  action: ACTION_KEY_ENUM;
  scope: PERMISSION_SCOPE_ENUM;
  /** Qué habilita, en lenguaje de negocio. No se persiste (ver docblock del archivo). */
  description: string;
}

/** Recursos que gobierna el catálogo. El seed no toca ningún otro (ORGANIZATION, USER...). */
export const STATIC_CATALOG_RESOURCES: Record<
  RESOURCE_KEY_ENUM.DOCUMENT | RESOURCE_KEY_ENUM.MEMBER,
  string
> = {
  // Texto idéntico al que ya sembró `seed:roles`: así la fila existente se reutiliza tal cual.
  [RESOURCE_KEY_ENUM.DOCUMENT]: 'Documentos para firma electrónica',
  [RESOURCE_KEY_ENUM.MEMBER]: 'Miembros de una organización',
};

/** Acciones que usa el catálogo, con la descripción que se guarda en `actions`. */
export const STATIC_CATALOG_ACTIONS: Record<
  | ACTION_KEY_ENUM.CREATE
  | ACTION_KEY_ENUM.READ
  | ACTION_KEY_ENUM.SEND_SIGNATURE_REQUEST
  | ACTION_KEY_ENUM.SIGN
  | ACTION_KEY_ENUM.APPROVE
  | ACTION_KEY_ENUM.INVITE,
  string
> = {
  [ACTION_KEY_ENUM.CREATE]: 'Crear un recurso nuevo',
  [ACTION_KEY_ENUM.READ]: 'Consultar un recurso existente',
  [ACTION_KEY_ENUM.SEND_SIGNATURE_REQUEST]: 'Enviar una solicitud de firma',
  [ACTION_KEY_ENUM.SIGN]: 'Firmar un documento',
  [ACTION_KEY_ENUM.APPROVE]: 'Aprobar o autorizar un recurso',
  [ACTION_KEY_ENUM.INVITE]: 'Invitar a un usuario',
};

/**
 * Los siete permisos del catálogo.
 *
 * `READ_OWN` y `READ_ORGANIZATION` comparten resource+action y se distinguen SÓLO por el scope
 * (`OWN` vs `ORGANIZATION`), que es justamente para lo que existe esa columna. Ninguno de los dos
 * es la fila `DOCUMENT+READ+ANY` que sembró `seed:roles`: aquella no distingue alcance y este
 * catálogo la sustituye (ver `--prune-superseded` en el seed).
 */
export const STATIC_PERMISSION_CATALOG: Record<
  STATIC_PERMISSION_KEY_ENUM,
  StaticPermissionDefinition
> = {
  [STATIC_PERMISSION_KEY_ENUM.DOCUMENT_CREATE]: {
    resource: RESOURCE_KEY_ENUM.DOCUMENT,
    action: ACTION_KEY_ENUM.CREATE,
    scope: PERMISSION_SCOPE_ENUM.ANY,
    description:
      'Crear documentos o borradores dentro de la organización activa.',
  },
  [STATIC_PERMISSION_KEY_ENUM.DOCUMENT_READ_OWN]: {
    resource: RESOURCE_KEY_ENUM.DOCUMENT,
    action: ACTION_KEY_ENUM.READ,
    scope: PERMISSION_SCOPE_ENUM.OWN,
    description:
      'Consultar documentos propios o donde el miembro sea firmante.',
  },
  [STATIC_PERMISSION_KEY_ENUM.DOCUMENT_READ_ORGANIZATION]: {
    resource: RESOURCE_KEY_ENUM.DOCUMENT,
    action: ACTION_KEY_ENUM.READ,
    scope: PERMISSION_SCOPE_ENUM.ORGANIZATION,
    description: 'Consultar documentos de toda la organización.',
  },
  [STATIC_PERMISSION_KEY_ENUM.DOCUMENT_SEND_SIGNATURE_REQUEST]: {
    resource: RESOURCE_KEY_ENUM.DOCUMENT,
    action: ACTION_KEY_ENUM.SEND_SIGNATURE_REQUEST,
    scope: PERMISSION_SCOPE_ENUM.ANY,
    description: 'Enviar solicitudes de firma de documentos autorizados.',
  },
  [STATIC_PERMISSION_KEY_ENUM.DOCUMENT_SIGN_SELF]: {
    resource: RESOURCE_KEY_ENUM.DOCUMENT,
    action: ACTION_KEY_ENUM.SIGN,
    scope: PERMISSION_SCOPE_ENUM.SELF,
    description: 'Firmar en nombre propio e incluirse como firmante.',
  },
  [STATIC_PERMISSION_KEY_ENUM.DOCUMENT_APPROVE]: {
    resource: RESOURCE_KEY_ENUM.DOCUMENT,
    action: ACTION_KEY_ENUM.APPROVE,
    scope: PERMISSION_SCOPE_ENUM.ANY,
    description:
      'Aprobar o autorizar documentos cuando el flujo existente lo soporte.',
  },
  [STATIC_PERMISSION_KEY_ENUM.MEMBER_INVITE]: {
    resource: RESOURCE_KEY_ENUM.MEMBER,
    action: ACTION_KEY_ENUM.INVITE,
    scope: PERMISSION_SCOPE_ENUM.ANY,
    description: 'Invitar miembros a la organización activa.',
  },
};

/**
 * Qué permisos del catálogo trae cada rol de sistema de fábrica.
 *
 * MEMBER se queda a propósito sin lectura de toda la organización, sin envío de solicitudes, sin
 * aprobación y sin invitación: son las cuatro capacidades que separan a un administrador de un
 * miembro raso. Un ADMIN que quiera dárselas a alguien concreto necesitará un rol custom de
 * organización, que este catálogo no toca.
 */
export const STATIC_ROLE_PERMISSION_MATRIX: Record<
  SYSTEM_ROLE_NAME_ENUM,
  STATIC_PERMISSION_KEY_ENUM[]
> = {
  [SYSTEM_ROLE_NAME_ENUM.ADMIN]: Object.values(STATIC_PERMISSION_KEY_ENUM),
  [SYSTEM_ROLE_NAME_ENUM.MEMBER]: [
    STATIC_PERMISSION_KEY_ENUM.DOCUMENT_CREATE,
    STATIC_PERMISSION_KEY_ENUM.DOCUMENT_READ_OWN,
    STATIC_PERMISSION_KEY_ENUM.DOCUMENT_SIGN_SELF,
  ],
};
