import 'reflect-metadata';
import * as dotenv from 'dotenv';
dotenv.config();

import { join } from 'path';
import {
  DataSource,
  DeepPartial,
  FindManyOptions,
  FindOneOptions,
  FindOptionsWhere,
  ObjectLiteral,
} from 'typeorm';

import { ActionEntity } from '../roles/entities/action.entity';
import { PermissionEntity } from '../roles/entities/permission.entity';
import { ResourceEntity } from '../roles/entities/resource.entity';
import { RolePermissionEntity } from '../roles/entities/role-permission.entity';
import { RoleEntity } from '../roles/entities/role.entity';
import { ACTION_KEY_ENUM } from '../roles/enums/action-key.enum';
import { RESOURCE_KEY_ENUM } from '../roles/enums/resource-key.enum';
import { SYSTEM_ROLE_NAME_ENUM } from '../roles/enums/system-role-name.enum';
import {
  STATIC_CATALOG_ACTIONS,
  STATIC_CATALOG_RESOURCES,
  STATIC_PERMISSION_CATALOG,
  STATIC_PERMISSION_KEY_ENUM,
  STATIC_ROLE_PERMISSION_MATRIX,
} from '../roles/static-permission-catalog';

/**
 * Carga el catálogo de permisos estáticos de organización en las tablas del RBAC
 * (`roles`, `resources`, `actions`, `permissions`, `role_permissions`).
 *
 * Qué es y qué no:
 *
 * - **Es idempotente y aditivo.** Cada fila se busca por su clave natural antes de insertarla
 *   (`key`, `name`+`isSystemRole`, `resource_id`+`action_id`+`scope`, `role_id`+`permission_id`),
 *   así que correrlo N veces deja exactamente el mismo resultado que correrlo una.
 * - **No borra nada por defecto.** Roles custom de organización, permisos sobre recursos fuera
 *   del catálogo (ORGANIZATION, USER) y cualquier asignación hecha a mano se quedan como están.
 * - **No es `seed:roles`.** Aquel sembró la rejilla CRUD completa (3 recursos × 4 acciones, todo
 *   con `scope: ANY`) y sigue siendo lo que consultan hoy los checks de `account` y
 *   `organization-permissions`, que preguntan por ORGANIZATION. Este script agrega encima el
 *   catálogo de negocio, sin tocar aquellas filas.
 *
 * El único caso en que borra es con `--prune-superseded`, y sólo sobre los pares recurso+acción
 * que el catálogo redefine con alcances explícitos: ver `revokeSupersededGrants`.
 *
 *   npm run seed:static-permissions                        # local, sobre src/
 *   npm run seed:static-permissions:prod                   # sobre dist/
 *   npm run seed:static-permissions -- --prune-superseded  # además revoca lo heredado
 */

/** Lo mínimo que el script necesita de un repositorio; tipado así para poder probarlo sin base. */
export interface CatalogRepository<Entity extends ObjectLiteral> {
  findOne(options: FindOneOptions<Entity>): Promise<Entity | null>;
  find(options?: FindManyOptions<Entity>): Promise<Entity[]>;
  save(entity: DeepPartial<Entity>): Promise<Entity>;
  delete(criteria: FindOptionsWhere<Entity>): Promise<unknown>;
}

/** Las cinco tablas del RBAC que toca el catálogo. */
export interface StaticPermissionCatalogRepositories {
  roles: CatalogRepository<RoleEntity>;
  resources: CatalogRepository<ResourceEntity>;
  actions: CatalogRepository<ActionEntity>;
  permissions: CatalogRepository<PermissionEntity>;
  rolePermissions: CatalogRepository<RolePermissionEntity>;
}

/**
 * Qué pasó con las filas de una tabla.
 *
 * `updated` sólo puede ser distinto de cero en `resources` y `actions`, las dos únicas tablas del
 * catálogo con una columna editable (`description`); en el resto, una fila o existe o se crea.
 */
export interface CatalogChangeCounters {
  created: number;
  reused: number;
  updated: number;
}

export interface StaticPermissionCatalogSummary {
  roles: CatalogChangeCounters;
  resources: CatalogChangeCounters;
  actions: CatalogChangeCounters;
  permissions: CatalogChangeCounters;
  /** Filas de `role_permissions`: la matriz rol → permiso. */
  grants: CatalogChangeCounters;
  /**
   * Asignaciones de un rol de sistema sobre un par recurso+acción que el catálogo redefine y que
   * la matriz ya no contempla (el caso real: `MEMBER → DOCUMENT+READ+ANY`, de `seed:roles`). Se
   * detectan siempre; se revocan sólo con `--prune-superseded`.
   */
  supersededGrants: { detected: number; revoked: number };
}

export interface SyncStaticPermissionCatalogOptions {
  /** Revocar las asignaciones heredadas que la matriz ya no contempla. Por defecto `false`. */
  pruneSuperseded?: boolean;
}

type CatalogLogger = {
  log(message: string): void;
  warn(message: string): void;
};

function emptyCounters(): CatalogChangeCounters {
  return { created: 0, reused: 0, updated: 0 };
}

/**
 * Crea el rol de sistema si falta y lo devuelve; si ya existe lo reutiliza sin tocarlo.
 *
 * Nunca actualiza el rol encontrado: su `id` es una FK real desde `accounts.role_id`, así que
 * reescribirlo (o recrearlo) desprendería a cada membresía de su rol. "Reutilizar sin alterar su
 * identidad" es el requisito, no una optimización.
 *
 * @param repositories - Repositorios de las tablas del RBAC.
 * @param name - Nombre del rol de sistema (`ADMIN` o `MEMBER`).
 * @param summary - Contadores de la corrida, que esta función incrementa.
 * @param logger - Dónde reportar si lo creó o lo reutilizó.
 * @returns El rol de sistema, recién creado o el que ya existía.
 *
 * @throws {QueryFailedError} Si la consulta contra Postgres falla (base inalcanzable, o tablas
 * del RBAC ausentes porque no se corrieron las migraciones).
 *
 * @example
 * ```ts
 * const admin = await upsertSystemRole(
 *   repositories,
 *   SYSTEM_ROLE_NAME_ENUM.ADMIN,
 *   summary,
 *   logger,
 * );
 * ```
 */
async function upsertSystemRole(
  repositories: StaticPermissionCatalogRepositories,
  name: SYSTEM_ROLE_NAME_ENUM,
  summary: StaticPermissionCatalogSummary,
  logger: CatalogLogger,
): Promise<RoleEntity> {
  const existing = await repositories.roles.findOne({
    where: { name, isSystemRole: true },
  });

  if (existing) {
    summary.roles.reused += 1;
    logger.log(`Rol ${name}: reutilizado (${existing.id}).`);
    return existing;
  }

  const created = await repositories.roles.save({
    name,
    isSystemRole: true,
    organizationId: null,
  });
  summary.roles.created += 1;
  logger.log(`Rol ${name}: creado (${created.id}).`);
  return created;
}

/**
 * Crea el recurso si falta, y si ya existe corrige su descripción sólo cuando cambió.
 *
 * @param repositories - Repositorios de las tablas del RBAC.
 * @param key - Clave del recurso (`DOCUMENT`, `MEMBER`).
 * @param description - Descripción que el catálogo declara para esa clave.
 * @param summary - Contadores de la corrida, que esta función incrementa.
 * @param logger - Dónde reportar si lo creó, reutilizó o actualizó.
 * @returns El recurso persistido.
 *
 * @throws {QueryFailedError} Si la consulta contra Postgres falla.
 *
 * @example
 * ```ts
 * const document = await upsertResource(
 *   repositories,
 *   RESOURCE_KEY_ENUM.DOCUMENT,
 *   'Documentos para firma electrónica',
 *   summary,
 *   logger,
 * );
 * ```
 */
async function upsertResource(
  repositories: StaticPermissionCatalogRepositories,
  key: RESOURCE_KEY_ENUM,
  description: string,
  summary: StaticPermissionCatalogSummary,
  logger: CatalogLogger,
): Promise<ResourceEntity> {
  const existing = await repositories.resources.findOne({ where: { key } });

  if (!existing) {
    const created = await repositories.resources.save({ key, description });
    summary.resources.created += 1;
    logger.log(`Recurso ${key}: creado.`);
    return created;
  }

  if (existing.description !== description) {
    const updated = await repositories.resources.save({
      ...existing,
      description,
    });
    summary.resources.updated += 1;
    logger.log(`Recurso ${key}: descripción actualizada.`);
    return updated;
  }

  summary.resources.reused += 1;
  logger.log(`Recurso ${key}: reutilizado.`);
  return existing;
}

/**
 * Crea la acción si falta, y si ya existe corrige su descripción sólo cuando cambió.
 *
 * @param repositories - Repositorios de las tablas del RBAC.
 * @param key - Clave de la acción (`CREATE`, `SIGN`, `INVITE`...).
 * @param description - Descripción que el catálogo declara para esa clave.
 * @param summary - Contadores de la corrida, que esta función incrementa.
 * @param logger - Dónde reportar si la creó, reutilizó o actualizó.
 * @returns La acción persistida.
 *
 * @throws {QueryFailedError} Si la consulta contra Postgres falla.
 *
 * @example
 * ```ts
 * const sign = await upsertAction(
 *   repositories,
 *   ACTION_KEY_ENUM.SIGN,
 *   'Firmar un documento',
 *   summary,
 *   logger,
 * );
 * ```
 */
async function upsertAction(
  repositories: StaticPermissionCatalogRepositories,
  key: ACTION_KEY_ENUM,
  description: string,
  summary: StaticPermissionCatalogSummary,
  logger: CatalogLogger,
): Promise<ActionEntity> {
  const existing = await repositories.actions.findOne({ where: { key } });

  if (!existing) {
    const created = await repositories.actions.save({ key, description });
    summary.actions.created += 1;
    logger.log(`Acción ${key}: creada.`);
    return created;
  }

  if (existing.description !== description) {
    const updated = await repositories.actions.save({
      ...existing,
      description,
    });
    summary.actions.updated += 1;
    logger.log(`Acción ${key}: descripción actualizada.`);
    return updated;
  }

  summary.actions.reused += 1;
  logger.log(`Acción ${key}: reutilizada.`);
  return existing;
}

/**
 * Crea el permiso `resource+action+scope` si falta y lo devuelve.
 *
 * @param repositories - Repositorios de las tablas del RBAC.
 * @param permissionKey - Clave del catálogo que se está materializando (para el log).
 * @param resource - Recurso ya persistido.
 * @param action - Acción ya persistida.
 * @param scope - Alcance declarado por el catálogo.
 * @param summary - Contadores de la corrida, que esta función incrementa.
 * @param logger - Dónde reportar si lo creó o lo reutilizó.
 * @returns El permiso persistido.
 *
 * @throws {QueryFailedError} Si la consulta contra Postgres falla.
 *
 * @example
 * ```ts
 * const permission = await upsertPermission(
 *   repositories,
 *   STATIC_PERMISSION_KEY_ENUM.DOCUMENT_SIGN_SELF,
 *   documentResource,
 *   signAction,
 *   PERMISSION_SCOPE_ENUM.SELF,
 *   summary,
 *   logger,
 * );
 * ```
 */
async function upsertPermission(
  repositories: StaticPermissionCatalogRepositories,
  permissionKey: STATIC_PERMISSION_KEY_ENUM,
  resource: ResourceEntity,
  action: ActionEntity,
  scope: string,
  summary: StaticPermissionCatalogSummary,
  logger: CatalogLogger,
): Promise<PermissionEntity> {
  const existing = await repositories.permissions.findOne({
    where: { resourceId: resource.id, actionId: action.id, scope },
  });

  if (existing) {
    summary.permissions.reused += 1;
    logger.log(`Permiso ${permissionKey}: reutilizado.`);
    return existing;
  }

  const created = await repositories.permissions.save({
    resourceId: resource.id,
    actionId: action.id,
    scope,
  });
  summary.permissions.created += 1;
  logger.log(`Permiso ${permissionKey}: creado.`);
  return created;
}

/**
 * Asigna el permiso al rol si aún no lo tiene.
 *
 * @param repositories - Repositorios de las tablas del RBAC.
 * @param role - Rol de sistema al que se asigna.
 * @param permission - Permiso del catálogo ya persistido.
 * @param permissionKey - Clave del catálogo (para el log).
 * @param summary - Contadores de la corrida, que esta función incrementa.
 * @param logger - Dónde reportar si la creó o si ya estaba.
 * @returns Nada; el efecto es la fila en `role_permissions`.
 *
 * @throws {QueryFailedError} Si la consulta contra Postgres falla.
 *
 * @example
 * ```ts
 * await upsertGrant(
 *   repositories,
 *   memberRole,
 *   permission,
 *   STATIC_PERMISSION_KEY_ENUM.DOCUMENT_CREATE,
 *   summary,
 *   logger,
 * );
 * ```
 */
async function upsertGrant(
  repositories: StaticPermissionCatalogRepositories,
  role: RoleEntity,
  permission: PermissionEntity,
  permissionKey: STATIC_PERMISSION_KEY_ENUM,
  summary: StaticPermissionCatalogSummary,
  logger: CatalogLogger,
): Promise<void> {
  const existing = await repositories.rolePermissions.findOne({
    where: { roleId: role.id, permissionId: permission.id },
  });

  if (existing) {
    summary.grants.reused += 1;
    logger.log(`${role.name} → ${permissionKey}: ya asignado.`);
    return;
  }

  await repositories.rolePermissions.save({
    roleId: role.id,
    permissionId: permission.id,
  });
  summary.grants.created += 1;
  logger.log(`${role.name} → ${permissionKey}: asignado.`);
}

/**
 * Detecta —y opcionalmente revoca— las asignaciones de un rol de sistema que el catálogo dejó
 * obsoletas.
 *
 * El caso real es `MEMBER → DOCUMENT+READ+ANY`, la fila que sembró `seed:roles`: al no distinguir
 * alcance equivale a lectura global, justo lo que la matriz le niega a MEMBER. Mientras siga ahí,
 * la matriz efectiva no es la documentada.
 *
 * "Obsoleta" es exigente a propósito: sólo cuenta una asignación sobre un par recurso+acción que
 * el catálogo REDEFINE con alcances explícitos (hoy `DOCUMENT`+`READ`, partido en `OWN` y
 * `ORGANIZATION`) y que la matriz de ese rol no contempla. `DOCUMENT`+`UPDATE`/`DELETE`, que el
 * catálogo no cubre, se preservan aunque sean del mismo recurso — igual que ORGANIZATION y USER,
 * que los consultan hoy `AccountService` y `OrganizationPermissionsService`. Los roles custom de
 * organización quedan fuera por completo: el barrido sólo mira los roles de sistema.
 *
 * @param repositories - Repositorios de las tablas del RBAC.
 * @param role - Rol de sistema a revisar.
 * @param expectedPermissionIds - Ids de los permisos que la matriz sí le da a ese rol.
 * @param catalogResourceActionPairs - Pares `resourceId:actionId` que el catálogo redefine.
 * @param prune - `true` para revocarlas; `false` para sólo reportarlas.
 * @param summary - Contadores de la corrida, que esta función incrementa.
 * @param logger - Dónde reportar cada asignación obsoleta.
 * @returns Nada; el efecto son las filas borradas y el aviso en consola.
 *
 * @throws {QueryFailedError} Si la consulta contra Postgres falla.
 *
 * @example
 * ```ts
 * await revokeSupersededGrants(
 *   repositories,
 *   memberRole,
 *   new Set([permission.id]),
 *   new Set([`${documentResource.id}:${readAction.id}`]),
 *   true,
 *   summary,
 *   logger,
 * );
 * ```
 */
async function revokeSupersededGrants(
  repositories: StaticPermissionCatalogRepositories,
  role: RoleEntity,
  expectedPermissionIds: Set<string>,
  catalogResourceActionPairs: Set<string>,
  prune: boolean,
  summary: StaticPermissionCatalogSummary,
  logger: CatalogLogger,
): Promise<void> {
  const grants = await repositories.rolePermissions.find({
    where: { roleId: role.id },
  });

  for (const grant of grants) {
    if (expectedPermissionIds.has(grant.permissionId)) continue;

    const permission = await repositories.permissions.findOne({
      where: { id: grant.permissionId },
    });
    if (
      !permission ||
      !catalogResourceActionPairs.has(
        `${permission.resourceId}:${permission.actionId}`,
      )
    ) {
      continue;
    }

    const action = await repositories.actions.findOne({
      where: { id: permission.actionId },
    });
    const label = `${role.name} → ${action?.key ?? permission.actionId} (scope ${permission.scope})`;

    summary.supersededGrants.detected += 1;

    if (!prune) {
      logger.warn(
        `${label}: asignación heredada que el catálogo ya no contempla. No se toca; ` +
          'correr con --prune-superseded para revocarla.',
      );
      continue;
    }

    await repositories.rolePermissions.delete({ id: grant.id });
    summary.supersededGrants.revoked += 1;
    logger.warn(`${label}: revocada por --prune-superseded.`);
  }
}

/**
 * Materializa el catálogo de permisos estáticos y devuelve el resumen de lo que hizo.
 *
 * Recorre el catálogo en el orden que manda la integridad referencial —roles, recursos, acciones,
 * permisos y por último `role_permissions`— y para cada fila decide entre crear, reutilizar o
 * (sólo en descripciones) actualizar. Nada se borra salvo con `pruneSuperseded`.
 *
 * @param repositories - Repositorios de las cinco tablas del RBAC.
 * @param logger - Dónde escribir el avance (`console`, el `Logger` de Nest o un doble en pruebas).
 * @param options - `pruneSuperseded` para revocar las asignaciones heredadas obsoletas.
 * @returns Cuántas filas creó, reutilizó y actualizó por tabla, más las asignaciones obsoletas
 * detectadas y revocadas.
 *
 * @throws {QueryFailedError} Si alguna consulta contra Postgres falla (base inalcanzable, o
 * tablas del RBAC ausentes porque no se corrieron las migraciones).
 *
 * @example
 * ```ts
 * const summary = await syncStaticPermissionCatalog(repositories, console, {
 *   pruneSuperseded: true,
 * });
 * console.log(summary.grants.created);
 * ```
 */
export async function syncStaticPermissionCatalog(
  repositories: StaticPermissionCatalogRepositories,
  logger: CatalogLogger,
  options: SyncStaticPermissionCatalogOptions = {},
): Promise<StaticPermissionCatalogSummary> {
  const summary: StaticPermissionCatalogSummary = {
    roles: emptyCounters(),
    resources: emptyCounters(),
    actions: emptyCounters(),
    permissions: emptyCounters(),
    grants: emptyCounters(),
    supersededGrants: { detected: 0, revoked: 0 },
  };

  logger.log('Roles de sistema...');
  const roles = new Map<SYSTEM_ROLE_NAME_ENUM, RoleEntity>();
  for (const name of Object.keys(
    STATIC_ROLE_PERMISSION_MATRIX,
  ) as SYSTEM_ROLE_NAME_ENUM[]) {
    roles.set(
      name,
      await upsertSystemRole(repositories, name, summary, logger),
    );
  }

  logger.log('Recursos del catálogo...');
  const resources = new Map<RESOURCE_KEY_ENUM, ResourceEntity>();
  for (const [key, description] of Object.entries(STATIC_CATALOG_RESOURCES)) {
    const resourceKey = key as RESOURCE_KEY_ENUM;
    resources.set(
      resourceKey,
      await upsertResource(
        repositories,
        resourceKey,
        description,
        summary,
        logger,
      ),
    );
  }

  logger.log('Acciones del catálogo...');
  const actions = new Map<ACTION_KEY_ENUM, ActionEntity>();
  for (const [key, description] of Object.entries(STATIC_CATALOG_ACTIONS)) {
    const actionKey = key as ACTION_KEY_ENUM;
    actions.set(
      actionKey,
      await upsertAction(repositories, actionKey, description, summary, logger),
    );
  }

  logger.log('Permisos del catálogo...');
  const permissions = new Map<STATIC_PERMISSION_KEY_ENUM, PermissionEntity>();
  for (const [key, definition] of Object.entries(STATIC_PERMISSION_CATALOG)) {
    const permissionKey = key as STATIC_PERMISSION_KEY_ENUM;
    permissions.set(
      permissionKey,
      await upsertPermission(
        repositories,
        permissionKey,
        resources.get(definition.resource)!,
        actions.get(definition.action)!,
        definition.scope,
        summary,
        logger,
      ),
    );
  }

  logger.log('Matriz rol → permisos...');
  // Pares recurso+acción que el catálogo redefine: el único terreno donde puede haber una
  // asignación obsoleta (ver `revokeSupersededGrants`).
  const catalogResourceActionPairs = new Set(
    Object.values(STATIC_PERMISSION_CATALOG).map(
      (definition) =>
        `${resources.get(definition.resource)!.id}:${actions.get(definition.action)!.id}`,
    ),
  );

  for (const [name, role] of roles) {
    const expectedPermissionIds = new Set<string>();

    for (const permissionKey of STATIC_ROLE_PERMISSION_MATRIX[name]) {
      const permission = permissions.get(permissionKey)!;
      expectedPermissionIds.add(permission.id);
      await upsertGrant(
        repositories,
        role,
        permission,
        permissionKey,
        summary,
        logger,
      );
    }

    await revokeSupersededGrants(
      repositories,
      role,
      expectedPermissionIds,
      catalogResourceActionPairs,
      options.pruneSuperseded === true,
      summary,
      logger,
    );
  }

  return summary;
}

/** Una línea del resumen final: `Recursos: 1 creados, 1 reutilizados, 0 actualizados.` */
function formatCounters(
  label: string,
  counters: CatalogChangeCounters,
): string {
  return `${label}: ${counters.created} creados, ${counters.reused} reutilizados, ${counters.updated} actualizados.`;
}

async function main(): Promise<void> {
  const pruneSuperseded = process.argv.includes('--prune-superseded');

  const dataSource = new DataSource({
    type: 'postgres',
    url: process.env.POSTGRES_DB_URL,
    // Mismo glob de doble extensión que `seed-roles.ts`: sirve para `src/` bajo ts-node y para
    // `dist/` bajo node, sin variable de entorno aparte.
    entities: [join(__dirname, '..', '**', '*.entity{.ts,.js}')],
    synchronize: false,
    logging: false,
  });

  await dataSource.initialize();
  console.log('Conectado a la base de datos.');

  try {
    const summary = await syncStaticPermissionCatalog(
      {
        roles: dataSource.getRepository(RoleEntity),
        resources: dataSource.getRepository(ResourceEntity),
        actions: dataSource.getRepository(ActionEntity),
        permissions: dataSource.getRepository(PermissionEntity),
        rolePermissions: dataSource.getRepository(RolePermissionEntity),
      },
      {
        log: (message: string) => console.log(message),
        warn: (message: string) => console.warn(message),
      },
      { pruneSuperseded },
    );

    console.log('---');
    console.log(formatCounters('Roles', summary.roles));
    console.log(formatCounters('Recursos', summary.resources));
    console.log(formatCounters('Acciones', summary.actions));
    console.log(formatCounters('Permisos', summary.permissions));
    console.log(formatCounters('Asignaciones rol → permiso', summary.grants));
    console.log(
      `Asignaciones heredadas obsoletas: ${summary.supersededGrants.detected} detectadas, ` +
        `${summary.supersededGrants.revoked} revocadas.`,
    );
    console.log('Catálogo de permisos estáticos al día.');
  } finally {
    await dataSource.destroy();
  }
}

// `require.main` distingue ejecutar el script de importarlo desde una prueba: sin esta guarda,
// importarlo abriría una conexión a Postgres.
if (require.main === module) {
  main().catch((error) => {
    console.error('Error cargando el catálogo de permisos estáticos:', error);
    process.exit(1);
  });
}
