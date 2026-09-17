import { ObjectLiteral } from 'typeorm';

import { ActionEntity } from '../roles/entities/action.entity';
import { PermissionEntity } from '../roles/entities/permission.entity';
import { ResourceEntity } from '../roles/entities/resource.entity';
import { RolePermissionEntity } from '../roles/entities/role-permission.entity';
import { RoleEntity } from '../roles/entities/role.entity';
import { SYSTEM_ROLE_NAME_ENUM } from '../roles/enums/system-role-name.enum';
import { buildPermissionKey } from '../roles/permission-catalog.util';
import {
  STATIC_CATALOG_ACTIONS,
  STATIC_CATALOG_RESOURCES,
  STATIC_PERMISSION_CATALOG,
  STATIC_PERMISSION_KEY_ENUM,
  STATIC_ROLE_PERMISSION_MATRIX,
} from '../roles/static-permission-catalog';
import {
  syncStaticPermissionCatalog,
  type CatalogRepository,
  type StaticPermissionCatalogRepositories,
} from './seed-static-permissions';

/**
 * El catálogo de permisos estáticos se carga con un script, no con una migración: no hay cambio
 * de esquema que revisar, sólo filas. Lo que sí hay que poder demostrar es que correrlo dos veces
 * no duplica nada, que la matriz resultante es exactamente la documentada y que no se lleva por
 * delante lo que ya había en las tablas del RBAC (la rejilla de `seed:roles`, roles custom).
 *
 * Las pruebas corren contra repositorios en memoria en vez de contra Postgres: la idempotencia se
 * juega en las búsquedas por clave natural que hace el script, y eso se observa igual de bien
 * contando filas en un arreglo — sin necesidad de infraestructura para `npm test`.
 */

type Persisted = ObjectLiteral & { id: string };

interface InMemoryRepository<
  Entity extends Persisted,
> extends CatalogRepository<Entity> {
  rows: Entity[];
}

/** Repositorio en memoria: `findOne`/`find` comparan por igualdad simple cada campo del `where`. */
function createInMemoryRepository<Entity extends Persisted>(
  idPrefix: string,
  initialRows: Entity[] = [],
): InMemoryRepository<Entity> {
  const rows = [...initialRows];
  let sequence = initialRows.length;

  const matches = (row: Entity, where: unknown): boolean => {
    if (!where) return true;
    return Object.entries(where as Record<string, unknown>).every(
      ([field, value]) => (row as Record<string, unknown>)[field] === value,
    );
  };

  return {
    rows,
    findOne: (options) =>
      Promise.resolve(rows.find((row) => matches(row, options.where)) ?? null),
    find: (options) =>
      Promise.resolve(rows.filter((row) => matches(row, options?.where))),
    save: (entity) => {
      const candidate = entity as unknown as Partial<Entity> & { id?: string };
      const existing = candidate.id
        ? rows.find((row) => row.id === candidate.id)
        : undefined;

      if (existing) {
        Object.assign(existing, candidate);
        return Promise.resolve(existing);
      }

      sequence += 1;
      const created = {
        ...candidate,
        id: `${idPrefix}-${sequence}`,
      } as unknown as Entity;
      rows.push(created);
      return Promise.resolve(created);
    },
    delete: (criteria) => {
      for (let index = rows.length - 1; index >= 0; index -= 1) {
        if (matches(rows[index], criteria)) rows.splice(index, 1);
      }
      return Promise.resolve(undefined);
    },
  };
}

interface TestRepositories extends StaticPermissionCatalogRepositories {
  roles: InMemoryRepository<RoleEntity>;
  resources: InMemoryRepository<ResourceEntity>;
  actions: InMemoryRepository<ActionEntity>;
  permissions: InMemoryRepository<PermissionEntity>;
  rolePermissions: InMemoryRepository<RolePermissionEntity>;
}

function createRepositories(): TestRepositories {
  return {
    roles: createInMemoryRepository<RoleEntity>('role'),
    resources: createInMemoryRepository<ResourceEntity>('resource'),
    actions: createInMemoryRepository<ActionEntity>('action'),
    permissions: createInMemoryRepository<PermissionEntity>('permission'),
    rolePermissions:
      createInMemoryRepository<RolePermissionEntity>('role-permission'),
  };
}

const silentLogger = { log: jest.fn(), warn: jest.fn() };

/** Siembra a mano lo que dejó `npm run seed:roles`: rejilla CRUD con `scope: ANY`. */
function seedLegacyGrid(repositories: TestRepositories): void {
  const admin = { id: 'role-admin', name: 'ADMIN', isSystemRole: true };
  const member = { id: 'role-member', name: 'MEMBER', isSystemRole: true };
  repositories.roles.rows.push(admin as RoleEntity, member as RoleEntity);

  const document = {
    id: 'resource-document',
    key: 'DOCUMENT',
    description: 'Documentos para firma electrónica',
  };
  const organization = {
    id: 'resource-organization',
    key: 'ORGANIZATION',
    description: 'Cuentas de tipo organización',
  };
  repositories.resources.rows.push(
    document as ResourceEntity,
    organization as ResourceEntity,
  );

  const read = {
    id: 'action-read',
    key: 'READ',
    description: 'Consultar un recurso existente',
  };
  const create = {
    id: 'action-create',
    key: 'CREATE',
    description: 'Crear un recurso nuevo',
  };
  const update = {
    id: 'action-update',
    key: 'UPDATE',
    description: 'Actualizar un recurso existente',
  };
  repositories.actions.rows.push(
    read as ActionEntity,
    create as ActionEntity,
    update as ActionEntity,
  );

  const documentReadAny = {
    id: 'permission-document-read-any',
    resourceId: document.id,
    actionId: read.id,
    scope: 'ANY',
  };
  const documentUpdateAny = {
    id: 'permission-document-update-any',
    resourceId: document.id,
    actionId: update.id,
    scope: 'ANY',
  };
  const organizationReadAny = {
    id: 'permission-organization-read-any',
    resourceId: organization.id,
    actionId: read.id,
    scope: 'ANY',
  };
  repositories.permissions.rows.push(
    documentReadAny as PermissionEntity,
    documentUpdateAny as PermissionEntity,
    organizationReadAny as PermissionEntity,
  );

  repositories.rolePermissions.rows.push(
    {
      id: 'grant-member-document-read-any',
      roleId: member.id,
      permissionId: documentReadAny.id,
    } as RolePermissionEntity,
    {
      id: 'grant-admin-document-read-any',
      roleId: admin.id,
      permissionId: documentReadAny.id,
    } as RolePermissionEntity,
    {
      id: 'grant-admin-document-update-any',
      roleId: admin.id,
      permissionId: documentUpdateAny.id,
    } as RolePermissionEntity,
    {
      id: 'grant-admin-organization-read-any',
      roleId: admin.id,
      permissionId: organizationReadAny.id,
    } as RolePermissionEntity,
  );
}

/** Un rol custom de organización con su propia asignación: nada de esto es del catálogo. */
function seedCustomOrganizationRole(repositories: TestRepositories): void {
  repositories.roles.rows.push({
    id: 'role-custom',
    name: 'AUDITOR',
    isSystemRole: false,
    organizationId: 'organization-1',
  } as RoleEntity);

  repositories.rolePermissions.rows.push({
    id: 'grant-custom',
    roleId: 'role-custom',
    permissionId: 'permission-document-read-any',
  } as RolePermissionEntity);
}

/** Los permisos de un rol, como `RECURSO.ACCION.ALCANCE`, para comparar contra la matriz. */
function grantedPermissionsOf(
  repositories: TestRepositories,
  roleName: string,
): string[] {
  const role = repositories.roles.rows.find(
    (candidate) => candidate.name === roleName && candidate.isSystemRole,
  );
  if (!role) return [];

  return repositories.rolePermissions.rows
    .filter((grant) => grant.roleId === role.id)
    .map((grant) => {
      const permission = repositories.permissions.rows.find(
        (candidate) => candidate.id === grant.permissionId,
      )!;
      const resource = repositories.resources.rows.find(
        (candidate) => candidate.id === permission.resourceId,
      )!;
      const action = repositories.actions.rows.find(
        (candidate) => candidate.id === permission.actionId,
      )!;
      return `${resource.key}.${action.key}.${permission.scope}`;
    })
    .sort();
}

/**
 * La matriz esperada de un rol, derivada del catálogo: `RECURSO.ACCION.ALCANCE` ordenado.
 *
 * Se calcula en vez de escribirse a mano para que estas pruebas no haya que reescribirlas cada vez
 * que el catálogo crece. Lo que sí se fija a mano —y es lo que de verdad se comprueba— es cuántos
 * permisos tiene cada rol y cuáles NO tiene (ver las pruebas de abajo).
 */
function expectedMatrixOf(role: SYSTEM_ROLE_NAME_ENUM): string[] {
  return STATIC_ROLE_PERMISSION_MATRIX[role]
    .map((key) => {
      const { resource, action, scope } = STATIC_PERMISSION_CATALOG[key];
      return `${resource}.${action}.${scope}`;
    })
    .sort();
}

const OWNER_MATRIX = expectedMatrixOf(SYSTEM_ROLE_NAME_ENUM.OWNER);
const ADMIN_MATRIX = expectedMatrixOf(SYSTEM_ROLE_NAME_ENUM.ADMIN);
const MEMBER_MATRIX = expectedMatrixOf(SYSTEM_ROLE_NAME_ENUM.MEMBER);

/** Cuántas filas debería dejar el catálogo sobre una base vacía. */
const CATALOG_SIZE = {
  resources: Object.keys(STATIC_CATALOG_RESOURCES).length,
  actions: Object.keys(STATIC_CATALOG_ACTIONS).length,
  permissions: Object.keys(STATIC_PERMISSION_CATALOG).length,
  grants: OWNER_MATRIX.length + ADMIN_MATRIX.length + MEMBER_MATRIX.length,
};

describe('syncStaticPermissionCatalog', () => {
  beforeEach(() => {
    silentLogger.log.mockClear();
    silentLogger.warn.mockClear();
  });

  it('sobre una base vacía crea el catálogo completo y la matriz documentada', async () => {
    const repositories = createRepositories();

    const summary = await syncStaticPermissionCatalog(
      repositories,
      silentLogger,
    );

    expect(summary.roles.created).toBe(3);
    expect(summary.resources.created).toBe(CATALOG_SIZE.resources);
    expect(summary.actions.created).toBe(CATALOG_SIZE.actions);
    expect(summary.permissions.created).toBe(CATALOG_SIZE.permissions);
    expect(summary.grants.created).toBe(CATALOG_SIZE.grants);

    expect(
      repositories.resources.rows.map((resource) => resource.key).sort(),
    ).toEqual(['BILLING', 'DOCUMENT', 'MEMBER', 'ORGANIZATION', 'ROLE']);
    expect(
      repositories.actions.rows.map((action) => action.key).sort(),
    ).toEqual([
      'APPROVE',
      'CANCEL',
      'CREATE',
      'INVITE',
      'MANAGE',
      'READ',
      'REMOVE',
      'SEND_SIGNATURE_REQUEST',
      'SIGN',
      'UPDATE',
    ]);
    expect(grantedPermissionsOf(repositories, 'OWNER')).toEqual(OWNER_MATRIX);
    expect(grantedPermissionsOf(repositories, 'ADMIN')).toEqual(ADMIN_MATRIX);
    expect(grantedPermissionsOf(repositories, 'MEMBER')).toEqual(MEMBER_MATRIX);
  });

  /** Las claves de la tabla de la historia, tal como las publica la API. */
  it('siembra todas las claves del catálogo, con su recurso, acción y alcance', async () => {
    const repositories = createRepositories();

    await syncStaticPermissionCatalog(repositories, silentLogger);

    const keys = repositories.permissions.rows
      .map((permission) => {
        const resource = repositories.resources.rows.find(
          (candidate) => candidate.id === permission.resourceId,
        )!;
        const action = repositories.actions.rows.find(
          (candidate) => candidate.id === permission.actionId,
        )!;
        return buildPermissionKey(resource.key, action.key, permission.scope);
      })
      .sort();

    expect(keys).toEqual(Object.values(STATIC_PERMISSION_KEY_ENUM).sort());
  });

  /** OWNER es el dueño de la cuenta: no hay capacidad del catálogo que no le toque. */
  it('OWNER recibe todos los permisos del catálogo', async () => {
    const repositories = createRepositories();

    await syncStaticPermissionCatalog(repositories, silentLogger);

    expect(grantedPermissionsOf(repositories, 'OWNER')).toHaveLength(
      CATALOG_SIZE.permissions,
    );
  });

  /**
   * La única diferencia entre los dos roles que administran. Si `MEMBER.REMOVE` se le colara a
   * ADMIN, el permiso dejaría de significar lo que la historia pide que signifique.
   */
  it('sólo OWNER recibe MEMBER.REMOVE', async () => {
    const repositories = createRepositories();

    await syncStaticPermissionCatalog(repositories, silentLogger);

    expect(grantedPermissionsOf(repositories, 'OWNER')).toContain(
      'MEMBER.REMOVE.ANY',
    );
    expect(grantedPermissionsOf(repositories, 'ADMIN')).not.toContain(
      'MEMBER.REMOVE.ANY',
    );
    expect(grantedPermissionsOf(repositories, 'MEMBER')).not.toContain(
      'MEMBER.REMOVE.ANY',
    );
  });

  /** MEMBER conserva exactamente las tres capacidades con las que nació. */
  it('MEMBER se queda con su matriz inicial y no hereda nada de la ampliación', async () => {
    const repositories = createRepositories();

    await syncStaticPermissionCatalog(repositories, silentLogger);

    const memberPermissions = grantedPermissionsOf(repositories, 'MEMBER');
    expect(memberPermissions).toEqual([
      'DOCUMENT.CREATE.ANY',
      'DOCUMENT.READ.OWN',
      'DOCUMENT.SIGN.SELF',
    ]);
    for (const denied of [
      'DOCUMENT.READ.ORGANIZATION',
      'DOCUMENT.SEND_SIGNATURE_REQUEST.ANY',
      'DOCUMENT.APPROVE.ANY',
      'DOCUMENT.CANCEL.ANY',
      'MEMBER.INVITE.ANY',
      'MEMBER.READ.ANY',
      'ORGANIZATION.READ.ANY',
      'BILLING.READ.ANY',
      'BILLING.MANAGE.ANY',
      'ROLE.READ.ANY',
      'ROLE.MANAGE.ANY',
    ]) {
      expect(memberPermissions).not.toContain(denied);
    }
  });

  it('persiste en MAYÚSCULAS las descripciones de recursos y acciones', async () => {
    const repositories = createRepositories();

    await syncStaticPermissionCatalog(repositories, silentLogger);

    for (const row of [
      ...repositories.resources.rows,
      ...repositories.actions.rows,
    ]) {
      expect(row.description).toBe(row.description.toUpperCase());
    }
  });

  it('correrlo tres veces no duplica ni una fila', async () => {
    const repositories = createRepositories();

    await syncStaticPermissionCatalog(repositories, silentLogger);
    const afterFirstRun = {
      roles: repositories.roles.rows.length,
      resources: repositories.resources.rows.length,
      actions: repositories.actions.rows.length,
      permissions: repositories.permissions.rows.length,
      grants: repositories.rolePermissions.rows.length,
    };

    const secondRun = await syncStaticPermissionCatalog(
      repositories,
      silentLogger,
    );
    const thirdRun = await syncStaticPermissionCatalog(
      repositories,
      silentLogger,
    );

    for (const summary of [secondRun, thirdRun]) {
      expect(summary.roles.created).toBe(0);
      expect(summary.resources.created).toBe(0);
      expect(summary.actions.created).toBe(0);
      expect(summary.permissions.created).toBe(0);
      expect(summary.grants.created).toBe(0);
      expect(summary.resources.updated).toBe(0);
      expect(summary.actions.updated).toBe(0);
      expect(summary.roles.reused).toBe(3);
      expect(summary.permissions.reused).toBe(CATALOG_SIZE.permissions);
      expect(summary.grants.reused).toBe(CATALOG_SIZE.grants);
    }

    expect({
      roles: repositories.roles.rows.length,
      resources: repositories.resources.rows.length,
      actions: repositories.actions.rows.length,
      permissions: repositories.permissions.rows.length,
      grants: repositories.rolePermissions.rows.length,
    }).toEqual(afterFirstRun);
    expect(grantedPermissionsOf(repositories, 'MEMBER')).toEqual(MEMBER_MATRIX);
  });

  /**
   * ADMIN y MEMBER conservan su `id`: reasignarlo dejaría huérfana a toda membresía que ya
   * apunte a ellos. OWNER sí se crea, porque la base que dejó `seed:roles` es anterior a él.
   */
  it('reutiliza los roles de sistema existentes sin alterar su identidad', async () => {
    const repositories = createRepositories();
    seedLegacyGrid(repositories);

    const summary = await syncStaticPermissionCatalog(
      repositories,
      silentLogger,
    );

    expect(summary.roles.created).toBe(1); // sólo OWNER, que no existía en la rejilla anterior
    expect(summary.roles.reused).toBe(2);
    expect(
      repositories.roles.rows.map((role) => `${role.id}:${role.name}`).sort(),
    ).toEqual(['role-1:OWNER', 'role-admin:ADMIN', 'role-member:MEMBER']);
  });

  it('preserva permisos y asignaciones ajenos al catálogo', async () => {
    const repositories = createRepositories();
    seedLegacyGrid(repositories);
    seedCustomOrganizationRole(repositories);

    await syncStaticPermissionCatalog(repositories, silentLogger);

    // ORGANIZATION+READ+ANY es la fila que el catálogo adopta como `ORGANIZATION.READ`: la
    // reutiliza, no crea otra al lado.
    expect(
      repositories.permissions.rows.filter(
        (permission) => permission.id === 'permission-organization-read-any',
      ),
    ).toHaveLength(1);
    // La asignación de ADMIN sobre ORGANIZATION es la que usan hoy los checks de `account`.
    expect(
      repositories.rolePermissions.rows.some(
        (grant) => grant.id === 'grant-admin-organization-read-any',
      ),
    ).toBe(true);
    // DOCUMENT+UPDATE es del recurso del catálogo, pero de una acción que el catálogo no redefine
    // sobre ese recurso: se preserva igual.
    expect(
      repositories.rolePermissions.rows.some(
        (grant) => grant.id === 'grant-admin-document-update-any',
      ),
    ).toBe(true);
    // El rol custom y su asignación quedan intactos.
    expect(
      repositories.roles.rows.some((role) => role.id === 'role-custom'),
    ).toBe(true);
    expect(
      repositories.rolePermissions.rows.some(
        (grant) => grant.id === 'grant-custom',
      ),
    ).toBe(true);
  });

  it('reutiliza los recursos y acciones existentes, actualizando sólo su descripción', async () => {
    const repositories = createRepositories();
    seedLegacyGrid(repositories);

    const summary = await syncStaticPermissionCatalog(
      repositories,
      silentLogger,
    );

    // DOCUMENT y ORGANIZATION ya estaban, con la descripción en minúsculas de `seed:roles`.
    expect(summary.resources.created).toBe(3); // BILLING, MEMBER, ROLE
    expect(summary.resources.updated).toBe(2); // DOCUMENT y ORGANIZATION, pasadas a MAYÚSCULAS
    expect(summary.actions.created).toBe(7);
    expect(summary.actions.updated).toBe(3); // CREATE, READ y UPDATE ya estaban
    expect(
      repositories.resources.rows.filter(
        (resource) => resource.key === 'DOCUMENT',
      ),
    ).toHaveLength(1);
  });

  it('corrige la descripción de un recurso del catálogo si cambió, y la deja en MAYÚSCULAS', async () => {
    const repositories = createRepositories();
    repositories.resources.rows.push({
      id: 'resource-document',
      key: 'DOCUMENT',
      description: 'Texto viejo',
    } as ResourceEntity);

    const summary = await syncStaticPermissionCatalog(
      repositories,
      silentLogger,
    );

    expect(summary.resources.updated).toBe(1);
    expect(
      repositories.resources.rows.find(
        (resource) => resource.key === 'DOCUMENT',
      )?.description,
    ).toBe('DOCUMENTOS PARA FIRMA ELECTRÓNICA');
  });

  it('detecta la lectura global heredada de MEMBER pero no la borra por defecto', async () => {
    const repositories = createRepositories();
    seedLegacyGrid(repositories);

    const summary = await syncStaticPermissionCatalog(
      repositories,
      silentLogger,
    );

    // Las dos asignaciones a DOCUMENT+READ+ANY (ADMIN y MEMBER); DOCUMENT+UPDATE+ANY no cuenta, y
    // ORGANIZATION+READ+ANY tampoco: ahora ES del catálogo y ADMIN lo tiene en su matriz.
    expect(summary.supersededGrants.detected).toBe(2);
    expect(summary.supersededGrants.revoked).toBe(0);
    expect(
      repositories.rolePermissions.rows.some(
        (grant) => grant.id === 'grant-member-document-read-any',
      ),
    ).toBe(true);
    expect(silentLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('--prune-superseded'),
    );
  });

  it('con --prune-superseded revoca la lectura global heredada y deja la matriz exacta', async () => {
    const repositories = createRepositories();
    seedLegacyGrid(repositories);
    seedCustomOrganizationRole(repositories);

    const summary = await syncStaticPermissionCatalog(
      repositories,
      silentLogger,
      { pruneSuperseded: true },
    );

    expect(summary.supersededGrants.revoked).toBe(2);
    expect(grantedPermissionsOf(repositories, 'MEMBER')).toEqual(MEMBER_MATRIX);
    // ADMIN conserva lo que el catálogo no redefine: DOCUMENT+UPDATE.
    expect(grantedPermissionsOf(repositories, 'ADMIN')).toEqual(
      [...ADMIN_MATRIX, 'DOCUMENT.UPDATE.ANY'].sort(),
    );
    // El rol custom no es de sistema: el barrido ni lo mira, aunque apunte al permiso revocado.
    expect(
      repositories.rolePermissions.rows.some(
        (grant) => grant.id === 'grant-custom',
      ),
    ).toBe(true);
  });

  /**
   * `MEMBER.DELETE` lo sembró la migración `AddMemberDeletePermission` y `MEMBER.REMOVE` lo
   * sustituye (ver `RETIRED_CATALOG_PERMISSIONS`). Mientras OWNER lo siga teniendo asignado, tiene
   * dos permisos para lo mismo y uno de ellos ya no existe en el catálogo.
   */
  describe('permisos retirados', () => {
    function seedRetiredMemberDelete(repositories: TestRepositories): void {
      const owner = { id: 'role-owner', name: 'OWNER', isSystemRole: true };
      repositories.roles.rows.push(owner as RoleEntity);
      repositories.resources.rows.push({
        id: 'resource-member',
        key: 'MEMBER',
        description: 'MIEMBROS DE UNA ORGANIZACIÓN',
      } as ResourceEntity);
      repositories.actions.rows.push({
        id: 'action-delete',
        key: 'DELETE',
        description: 'ELIMINAR UN RECURSO EXISTENTE',
      } as ActionEntity);
      repositories.permissions.rows.push({
        id: 'permission-member-delete-any',
        resourceId: 'resource-member',
        actionId: 'action-delete',
        scope: 'ANY',
      } as PermissionEntity);
      repositories.rolePermissions.rows.push({
        id: 'grant-owner-member-delete-any',
        roleId: owner.id,
        permissionId: 'permission-member-delete-any',
      } as RolePermissionEntity);
    }

    it('reporta la asignación retirada sin borrarla por defecto', async () => {
      const repositories = createRepositories();
      seedRetiredMemberDelete(repositories);

      const summary = await syncStaticPermissionCatalog(
        repositories,
        silentLogger,
      );

      expect(summary.supersededGrants.detected).toBe(1);
      expect(summary.supersededGrants.revoked).toBe(0);
      expect(grantedPermissionsOf(repositories, 'OWNER')).toContain(
        'MEMBER.DELETE.ANY',
      );
    });

    it('con --prune-superseded la revoca y deja MEMBER.REMOVE en su lugar', async () => {
      const repositories = createRepositories();
      seedRetiredMemberDelete(repositories);

      await syncStaticPermissionCatalog(repositories, silentLogger, {
        pruneSuperseded: true,
      });

      const ownerPermissions = grantedPermissionsOf(repositories, 'OWNER');
      expect(ownerPermissions).not.toContain('MEMBER.DELETE.ANY');
      expect(ownerPermissions).toContain('MEMBER.REMOVE.ANY');
      // La fila de `permissions` no se borra: puede seguir referenciada por un rol custom.
      expect(
        repositories.permissions.rows.some(
          (permission) => permission.id === 'permission-member-delete-any',
        ),
      ).toBe(true);
    });
  });
});
