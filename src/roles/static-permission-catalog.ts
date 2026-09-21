import { ACTION_KEY_ENUM } from './enums/action-key.enum';
import { PERMISSION_SCOPE_ENUM } from './enums/permission-scope.enum';
import { RESOURCE_KEY_ENUM } from './enums/resource-key.enum';
import { SYSTEM_ROLE_NAME_ENUM } from './enums/system-role-name.enum';

/**
 * Catálogo de permisos ESTÁTICOS: la lista cerrada de cosas que una cuenta podrá hacer, y qué
 * rol de sistema trae cada una de fábrica.
 *
 * Es la única fuente de verdad del catálogo. `npm run seed:static-permissions` lo materializa en
 * `resources`/`actions`/`permissions`/`role_permissions`, `permission-catalog.util.ts` lo publica
 * hacia la API y el frontend, y el futuro RBAC efectivo leerá de aquí las claves con las que
 * proteger endpoints — por eso vive en `src/roles/` y no en `src/scripts/`.
 *
 * **Todas las descripciones se escriben y se persisten en MAYÚSCULAS.** Es un requisito de
 * presentación de la historia del catálogo, y por eso no depende de que quien edite este archivo
 * se acuerde: `normalizeCatalogDescription` las normaliza al escribirlas en base y al publicarlas,
 * y una prueba comprueba que el catálogo ya las declara así.
 *
 * Las cuentas personales TAMBIÉN pasan por aquí, pero sólo por la mitad del catálogo que no
 * exige una organización detrás: `organizationOnly` marca cuál es cada mitad y
 * `personal-account-permissions.ts` deriva de aquí lo que una cuenta PERSONAL puede ejercer,
 * sin consultar su rol. Una cuenta PERSONAL nace con el rol de sistema OWNER —que trae el
 * catálogo entero— y sin ese recorte se llevaría también los permisos de administrar una
 * organización que no tiene.
 *
 * Dos cosas que NO son este catálogo:
 *
 * - **`organization_permissions`.** Es un sistema paralelo de nombres libres que cada ADMIN
 *   define para su organización ("puede aprobar gastos"); no otorga acceso técnico a nada y no
 *   se toca desde aquí.
 * - **La descripción del permiso en base de datos.** `permissions` no tiene columna
 *   `description` y este catálogo no agrega una: la descripción de cada permiso vive acá, en
 *   código, y viaja a la UI derivada en `permission-catalog.util.ts`. Las de `resources` y
 *   `actions` sí son columnas y el seed las mantiene al día.
 */

/** Clave estable de cada permiso del catálogo, en formato `RECURSO.ACCION[_ALCANCE]`. */
export enum STATIC_PERMISSION_KEY_ENUM {
  ORGANIZATION_READ = 'ORGANIZATION.READ',
  ORGANIZATION_UPDATE = 'ORGANIZATION.UPDATE',
  BILLING_READ = 'BILLING.READ',
  BILLING_MANAGE = 'BILLING.MANAGE',
  MEMBER_READ = 'MEMBER.READ',
  MEMBER_INVITE = 'MEMBER.INVITE',
  MEMBER_UPDATE = 'MEMBER.UPDATE',
  MEMBER_REMOVE = 'MEMBER.REMOVE',
  ROLE_READ = 'ROLE.READ',
  ROLE_MANAGE = 'ROLE.MANAGE',
  DOCUMENT_CREATE = 'DOCUMENT.CREATE',
  DOCUMENT_READ_OWN = 'DOCUMENT.READ_OWN',
  DOCUMENT_READ_ORGANIZATION = 'DOCUMENT.READ_ORGANIZATION',
  DOCUMENT_SEND_SIGNATURE_REQUEST = 'DOCUMENT.SEND_SIGNATURE_REQUEST',
  DOCUMENT_SIGN_SELF = 'DOCUMENT.SIGN_SELF',
  DOCUMENT_APPROVE = 'DOCUMENT.APPROVE',
  DOCUMENT_CANCEL = 'DOCUMENT.CANCEL',
}

/** Cómo se materializa una clave del catálogo en una fila de `permissions`. */
export interface StaticPermissionDefinition {
  resource: RESOURCE_KEY_ENUM;
  action: ACTION_KEY_ENUM;
  scope: PERMISSION_SCOPE_ENUM;
  description: string;

  /**
   * Si el permiso sólo tiene sentido dentro de una organización.
   *
   * Es un campo OBLIGATORIO, y ahí está su gracia: agregar una clave nueva al catálogo no
   * compila hasta que alguien decida a cuál de los dos mundos pertenece. Un permiso futuro
   * ligado a una organización queda fuera de las cuentas personales por construcción, sin que
   * nadie tenga que acordarse de mantener una lista aparte.
   *
   * `true` para lo que necesita una organización detrás: su ficha (`ORGANIZATION.*`), sus
   * miembros (`MEMBER.*`), sus roles (`ROLE.*`), leer los documentos de todos
   * (`DOCUMENT.READ_ORGANIZATION`) y aprobarlos (`DOCUMENT.APPROVE`, que exige un aprobador
   * miembro — ver `CreateDocumentSignatureFlowUseCase`, que rechaza `requiresApproval` en una
   * cuenta personal).
   *
   * `false` para lo que una persona ejerce sobre lo suyo: su plan y sus pagos (`BILLING.*`) y
   * sus propios documentos (crear, ver los suyos, mandarlos a firma, firmar y cancelar).
   */
  organizationOnly: boolean;
}
export function normalizeCatalogDescription(description: string): string {
  return description.trim().toUpperCase();
}

/**
 * Recursos que gobierna el catálogo.
 *
 * `ORGANIZATION` y `DOCUMENT` ya existían por `seed:roles`; el catálogo reutiliza esas filas y
 * sólo les corrige la descripción. `USER`, que también sembró aquél, queda fuera: ningún permiso
 * de este catálogo lo usa.
 */
export const STATIC_CATALOG_RESOURCES: Record<
  | RESOURCE_KEY_ENUM.ORGANIZATION
  | RESOURCE_KEY_ENUM.BILLING
  | RESOURCE_KEY_ENUM.MEMBER
  | RESOURCE_KEY_ENUM.ROLE
  | RESOURCE_KEY_ENUM.DOCUMENT,
  string
> = {
  [RESOURCE_KEY_ENUM.ORGANIZATION]: 'CUENTAS DE TIPO ORGANIZACIÓN',
  [RESOURCE_KEY_ENUM.BILLING]: 'PLAN, PAGOS Y SUSCRIPCIÓN DE LA ORGANIZACIÓN',
  [RESOURCE_KEY_ENUM.MEMBER]: 'MIEMBROS DE UNA ORGANIZACIÓN',
  [RESOURCE_KEY_ENUM.ROLE]: 'ROLES Y PERMISOS DE LA ORGANIZACIÓN',
  [RESOURCE_KEY_ENUM.DOCUMENT]: 'DOCUMENTOS PARA FIRMA ELECTRÓNICA',
};

/** Acciones que usa el catálogo, con la descripción que se guarda en `actions`. */
export const STATIC_CATALOG_ACTIONS: Record<
  | ACTION_KEY_ENUM.CREATE
  | ACTION_KEY_ENUM.READ
  | ACTION_KEY_ENUM.UPDATE
  | ACTION_KEY_ENUM.MANAGE
  | ACTION_KEY_ENUM.INVITE
  | ACTION_KEY_ENUM.REMOVE
  | ACTION_KEY_ENUM.SEND_SIGNATURE_REQUEST
  | ACTION_KEY_ENUM.SIGN
  | ACTION_KEY_ENUM.APPROVE
  | ACTION_KEY_ENUM.CANCEL,
  string
> = {
  [ACTION_KEY_ENUM.CREATE]: 'CREAR UN RECURSO NUEVO',
  [ACTION_KEY_ENUM.READ]: 'CONSULTAR UN RECURSO EXISTENTE',
  [ACTION_KEY_ENUM.UPDATE]: 'ACTUALIZAR UN RECURSO EXISTENTE',
  [ACTION_KEY_ENUM.MANAGE]: 'ADMINISTRAR UN RECURSO Y SU CONFIGURACIÓN',
  [ACTION_KEY_ENUM.INVITE]: 'INVITAR A UN USUARIO',
  [ACTION_KEY_ENUM.REMOVE]: 'REVOCAR O ELIMINAR UNA MEMBRESÍA',
  [ACTION_KEY_ENUM.SEND_SIGNATURE_REQUEST]: 'ENVIAR UNA SOLICITUD DE FIRMA',
  [ACTION_KEY_ENUM.SIGN]: 'FIRMAR UN DOCUMENTO',
  [ACTION_KEY_ENUM.APPROVE]: 'APROBAR O AUTORIZAR UN RECURSO',
  [ACTION_KEY_ENUM.CANCEL]: 'SOLICITAR O CONFIRMAR UNA CANCELACIÓN',
};

/**
 * Los diecisiete permisos del catálogo, en el orden en que la UI los lista.
 *
 * Las descripciones son las de la tabla de la historia, palabra por palabra: son lo que se ve en
 * pantalla, así que cambiarlas aquí cambia lo que lee quien arma un rol.
 *
 * `READ_OWN` y `READ_ORGANIZATION` comparten resource+action y se distinguen SÓLO por el scope
 * (`OWN` vs `ORGANIZATION`), que es justamente para lo que existe esa columna. Ninguno de los dos
 * es la fila `DOCUMENT+READ+ANY` que sembró `seed:roles`: aquella no distingue alcance y este
 * catálogo la sustituye (ver `--prune-superseded` en el seed).
 *
 * `ORGANIZATION.READ` y `ORGANIZATION.UPDATE` sí son exactamente las filas de aquella rejilla
 * (`ORGANIZATION`+`READ`/`UPDATE`+`ANY`), las mismas que hoy consultan `AccountService` y
 * `OrganizationPermissionsService`: el catálogo las adopta y les pone nombre, no crea otras.
 */
export const STATIC_PERMISSION_CATALOG: Record<
  STATIC_PERMISSION_KEY_ENUM,
  StaticPermissionDefinition
> = {
  [STATIC_PERMISSION_KEY_ENUM.ORGANIZATION_READ]: {
    resource: RESOURCE_KEY_ENUM.ORGANIZATION,
    action: ACTION_KEY_ENUM.READ,
    scope: PERMISSION_SCOPE_ENUM.ANY,
    description: 'VER DATOS Y CONFIGURACIÓN DE LA ORGANIZACIÓN ACTIVA',
    organizationOnly: true,
  },
  [STATIC_PERMISSION_KEY_ENUM.ORGANIZATION_UPDATE]: {
    resource: RESOURCE_KEY_ENUM.ORGANIZATION,
    action: ACTION_KEY_ENUM.UPDATE,
    scope: PERMISSION_SCOPE_ENUM.ANY,
    description: 'EDITAR DATOS Y CONFIGURACIÓN DE LA ORGANIZACIÓN',
    organizationOnly: true,
  },
  [STATIC_PERMISSION_KEY_ENUM.BILLING_READ]: {
    resource: RESOURCE_KEY_ENUM.BILLING,
    action: ACTION_KEY_ENUM.READ,
    scope: PERMISSION_SCOPE_ENUM.ANY,
    description: 'VER PLAN, PAGOS, FACTURAS Y ESTADO DE SUSCRIPCIÓN',
    organizationOnly: false,
  },
  [STATIC_PERMISSION_KEY_ENUM.BILLING_MANAGE]: {
    resource: RESOURCE_KEY_ENUM.BILLING,
    action: ACTION_KEY_ENUM.MANAGE,
    scope: PERMISSION_SCOPE_ENUM.ANY,
    description: 'INICIAR PAGO, CAMBIAR, CANCELAR O ADMINISTRAR EL PLAN',
    organizationOnly: false,
  },
  [STATIC_PERMISSION_KEY_ENUM.MEMBER_READ]: {
    resource: RESOURCE_KEY_ENUM.MEMBER,
    action: ACTION_KEY_ENUM.READ,
    scope: PERMISSION_SCOPE_ENUM.ANY,
    description: 'VER MIEMBROS',
    organizationOnly: true,
  },
  [STATIC_PERMISSION_KEY_ENUM.MEMBER_INVITE]: {
    resource: RESOURCE_KEY_ENUM.MEMBER,
    action: ACTION_KEY_ENUM.INVITE,
    scope: PERMISSION_SCOPE_ENUM.ANY,
    description: 'INVITAR O AGREGAR MIEMBROS',
    organizationOnly: true,
  },
  [STATIC_PERMISSION_KEY_ENUM.MEMBER_UPDATE]: {
    resource: RESOURCE_KEY_ENUM.MEMBER,
    action: ACTION_KEY_ENUM.UPDATE,
    scope: PERMISSION_SCOPE_ENUM.ANY,
    description: 'CAMBIAR ROL O DATOS DE UN MIEMBRO',
    organizationOnly: true,
  },
  [STATIC_PERMISSION_KEY_ENUM.MEMBER_REMOVE]: {
    resource: RESOURCE_KEY_ENUM.MEMBER,
    action: ACTION_KEY_ENUM.REMOVE,
    scope: PERMISSION_SCOPE_ENUM.ANY,
    description: 'REVOCAR O ELIMINAR MEMBRESÍAS',
    organizationOnly: true,
  },
  [STATIC_PERMISSION_KEY_ENUM.ROLE_READ]: {
    resource: RESOURCE_KEY_ENUM.ROLE,
    action: ACTION_KEY_ENUM.READ,
    scope: PERMISSION_SCOPE_ENUM.ANY,
    description: 'VER ROLES Y SUS PERMISOS',
    organizationOnly: true,
  },
  [STATIC_PERMISSION_KEY_ENUM.ROLE_MANAGE]: {
    resource: RESOURCE_KEY_ENUM.ROLE,
    action: ACTION_KEY_ENUM.MANAGE,
    scope: PERMISSION_SCOPE_ENUM.ANY,
    description: 'CREAR O EDITAR ROLES PERSONALIZADOS',
    organizationOnly: true,
  },
  [STATIC_PERMISSION_KEY_ENUM.DOCUMENT_CREATE]: {
    resource: RESOURCE_KEY_ENUM.DOCUMENT,
    action: ACTION_KEY_ENUM.CREATE,
    scope: PERMISSION_SCOPE_ENUM.ANY,
    description: 'CREAR DOCUMENTOS',
    organizationOnly: false,
  },
  [STATIC_PERMISSION_KEY_ENUM.DOCUMENT_READ_OWN]: {
    resource: RESOURCE_KEY_ENUM.DOCUMENT,
    action: ACTION_KEY_ENUM.READ,
    scope: PERMISSION_SCOPE_ENUM.OWN,
    description: 'VER DOCUMENTOS PROPIOS O DONDE PARTICIPA',
    organizationOnly: false,
  },
  [STATIC_PERMISSION_KEY_ENUM.DOCUMENT_READ_ORGANIZATION]: {
    resource: RESOURCE_KEY_ENUM.DOCUMENT,
    action: ACTION_KEY_ENUM.READ,
    scope: PERMISSION_SCOPE_ENUM.ORGANIZATION,
    description: 'VER DOCUMENTOS DE TODA LA ORGANIZACIÓN',
    organizationOnly: true,
  },
  [STATIC_PERMISSION_KEY_ENUM.DOCUMENT_SEND_SIGNATURE_REQUEST]: {
    resource: RESOURCE_KEY_ENUM.DOCUMENT,
    action: ACTION_KEY_ENUM.SEND_SIGNATURE_REQUEST,
    scope: PERMISSION_SCOPE_ENUM.ANY,
    description: 'ENVIAR SOLICITUDES DE FIRMA',
    organizationOnly: false,
  },
  [STATIC_PERMISSION_KEY_ENUM.DOCUMENT_SIGN_SELF]: {
    resource: RESOURCE_KEY_ENUM.DOCUMENT,
    action: ACTION_KEY_ENUM.SIGN,
    scope: PERMISSION_SCOPE_ENUM.SELF,
    description: 'FIRMAR COMO PARTICIPANTE',
    organizationOnly: false,
  },
  [STATIC_PERMISSION_KEY_ENUM.DOCUMENT_APPROVE]: {
    resource: RESOURCE_KEY_ENUM.DOCUMENT,
    action: ACTION_KEY_ENUM.APPROVE,
    scope: PERMISSION_SCOPE_ENUM.ANY,
    description: 'APROBAR DOCUMENTOS, SI EL FLUJO LO REQUIERE',
    organizationOnly: true,
  },
  [STATIC_PERMISSION_KEY_ENUM.DOCUMENT_CANCEL]: {
    resource: RESOURCE_KEY_ENUM.DOCUMENT,
    action: ACTION_KEY_ENUM.CANCEL,
    scope: PERMISSION_SCOPE_ENUM.ANY,
    description: 'SOLICITAR O CONFIRMAR CANCELACIONES, SEGÚN EL FLUJO',
    organizationOnly: false,
  },
};

/**
 * Pares recurso+acción que el catálogo RETIRÓ: ya no tienen clave, pero sus filas siguen en la
 * base porque alguna vez se sembraron.
 *
 * Hoy sólo `MEMBER`+`DELETE`, que sembró la migración `AddMemberDeletePermission` y que
 * `MEMBER.REMOVE` sustituye con el nombre que usa la tabla de la historia. El seed los trata como
 * asignaciones obsoletas: los reporta siempre y los revoca con `--prune-superseded`, igual que a
 * la rejilla heredada. La fila de `permissions` no se borra: puede seguir referenciada por un rol
 * custom de alguna organización.
 */
export const RETIRED_CATALOG_PERMISSIONS: ReadonlyArray<{
  resource: RESOURCE_KEY_ENUM;
  action: ACTION_KEY_ENUM;
  /** Clave del catálogo que la sustituye, para el log del seed. */
  supersededBy: STATIC_PERMISSION_KEY_ENUM;
}> = [
  {
    resource: RESOURCE_KEY_ENUM.MEMBER,
    action: ACTION_KEY_ENUM.DELETE,
    supersededBy: STATIC_PERMISSION_KEY_ENUM.MEMBER_REMOVE,
  },
];

/**
 * Qué permisos del catálogo trae cada rol de sistema de fábrica.
 *
 * OWNER recibe el catálogo completo, sin excepciones: es quien es dueño de la cuenta.
 *
 * ADMIN trae todo menos `MEMBER.REMOVE` —dar de baja a alguien de la organización sigue siendo la
 * capacidad reservada al propietario, como cuando esa fila se llamaba `MEMBER.DELETE`—, así que la
 * diferencia entre los dos roles es exactamente ese permiso. Lo otro que los separa es de dónde
 * viene el rol: OWNER se asigna solo al crear la cuenta y ADMIN lo otorga el propietario a un
 * miembro (ver `SYSTEM_ROLE_NAME_ENUM`). ADMIN se enumera en vez de escribirse como
 * `Object.values(...)`: un permiso nuevo del catálogo no debe colársele solo.
 *
 * MEMBER conserva exactamente las tres capacidades con las que nació —crear, ver lo suyo y
 * firmar—, y la ampliación del catálogo no le agrega ninguna: leer toda la organización,
 * facturación, miembros, roles, enviar solicitudes, aprobar y cancelar son lo que separa a un
 * administrador de un miembro raso. Un ADMIN que quiera dárselas a alguien concreto necesitará un
 * rol custom de organización, que este catálogo no toca.
 */
export const STATIC_ROLE_PERMISSION_MATRIX: Record<
  SYSTEM_ROLE_NAME_ENUM,
  STATIC_PERMISSION_KEY_ENUM[]
> = {
  [SYSTEM_ROLE_NAME_ENUM.OWNER]: Object.values(STATIC_PERMISSION_KEY_ENUM),
  [SYSTEM_ROLE_NAME_ENUM.ADMIN]: [
    STATIC_PERMISSION_KEY_ENUM.ORGANIZATION_READ,
    STATIC_PERMISSION_KEY_ENUM.ORGANIZATION_UPDATE,
    STATIC_PERMISSION_KEY_ENUM.BILLING_READ,
    STATIC_PERMISSION_KEY_ENUM.BILLING_MANAGE,
    STATIC_PERMISSION_KEY_ENUM.MEMBER_READ,
    STATIC_PERMISSION_KEY_ENUM.MEMBER_INVITE,
    STATIC_PERMISSION_KEY_ENUM.MEMBER_UPDATE,
    STATIC_PERMISSION_KEY_ENUM.ROLE_READ,
    STATIC_PERMISSION_KEY_ENUM.ROLE_MANAGE,
    STATIC_PERMISSION_KEY_ENUM.DOCUMENT_CREATE,
    STATIC_PERMISSION_KEY_ENUM.DOCUMENT_READ_OWN,
    STATIC_PERMISSION_KEY_ENUM.DOCUMENT_READ_ORGANIZATION,
    STATIC_PERMISSION_KEY_ENUM.DOCUMENT_SEND_SIGNATURE_REQUEST,
    STATIC_PERMISSION_KEY_ENUM.DOCUMENT_SIGN_SELF,
    STATIC_PERMISSION_KEY_ENUM.DOCUMENT_APPROVE,
    STATIC_PERMISSION_KEY_ENUM.DOCUMENT_CANCEL,
  ],
  [SYSTEM_ROLE_NAME_ENUM.MEMBER]: [
    STATIC_PERMISSION_KEY_ENUM.DOCUMENT_CREATE,
    STATIC_PERMISSION_KEY_ENUM.DOCUMENT_READ_OWN,
    STATIC_PERMISSION_KEY_ENUM.DOCUMENT_SIGN_SELF,
  ],
};
