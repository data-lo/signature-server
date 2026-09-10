import { ObjectLiteral } from 'typeorm';

import { ActionEntity } from '../roles/entities/action.entity';
import { PermissionEntity } from '../roles/entities/permission.entity';
import { ResourceEntity } from '../roles/entities/resource.entity';
import { RolePermissionEntity } from '../roles/entities/role-permission.entity';
import { RoleEntity } from '../roles/entities/role.entity';
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

const ADMIN_MATRIX = [
  'DOCUMENT.APPROVE.ANY',
  'DOCUMENT.CREATE.ANY',
  'DOCUMENT.READ.ORGANIZATION',
  'DOCUMENT.READ.OWN',
  'DOCUMENT.SEND_SIGNATURE_REQUEST.ANY',
  'DOCUMENT.SIGN.SELF',
  'MEMBER.INVITE.ANY',
];

const MEMBER_MATRIX = [
  'DOCUMENT.CREATE.ANY',
  'DOCUMENT.READ.OWN',
  'DOCUMENT.SIGN.SELF',
];

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

    expect(summary.roles.created).toBe(2);
    expect(summary.resources.created).toBe(2);
    expect(summary.actions.created).toBe(6);
    expect(summary.permissions.created).toBe(7);
    expect(summary.grants.created).toBe(10);

    expect(
      repositories.resources.rows.map((resource) => resource.key).sort(),
    ).toEqual(['DOCUMENT', 'MEMBER']);
    expect(
      repositories.actions.rows.map((action) => action.key).sort(),
    ).toEqual([
      'APPROVE',
      'CREATE',
      'INVITE',
      'READ',
      'SEND_SIGNATURE_REQUEST',
      'SIGN',
    ]);
    expect(grantedPermissionsOf(repositories, 'ADMIN')).toEqual(ADMIN_MATRIX);
    expect(grantedPermissionsOf(repositories, 'MEMBER')).toEqual(MEMBER_MATRIX);
  });

  it('MEMBER no recibe lectura de organización, envío de solicitudes, aprobación ni invitación', async () => {
    const repositories = createRepositories();

    await syncStaticPermissionCatalog(repositories, silentLogger);

    const memberPermissions = grantedPermissionsOf(repositories, 'MEMBER');
    expect(memberPermissions).not.toContain('DOCUMENT.READ.ORGANIZATION');
    expect(memberPermissions).not.toContain(
      'DOCUMENT.SEND_SIGNATURE_REQUEST.ANY',
    );
    expect(memberPermissions).not.toContain('DOCUMENT.APPROVE.ANY');
    expect(memberPermissions).not.toContain('MEMBER.INVITE.ANY');
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
      expect(summary.roles.reused).toBe(2);
      expect(summary.permissions.reused).toBe(7);
      expect(summary.grants.reused).toBe(10);
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

  it('reutiliza los roles de sistema existentes sin alterar su identidad', async () => {
    const repositories = createRepositories();
    seedLegacyGrid(repositories);

    const summary = await syncStaticPermissionCatalog(
      repositories,
      silentLogger,
    );

    expect(summary.roles.created).toBe(0);
    expect(summary.roles.reused).toBe(2);
    expect(
      repositories.roles.rows.map((role) => `${role.id}:${role.name}`).sort(),
    ).toEqual(['role-admin:ADMIN', 'role-member:MEMBER']);
  });

  it('preserva permisos, recursos y asignaciones ajenos al catálogo', async () => {
    const repositories = createRepositories();
    seedLegacyGrid(repositories);
    seedCustomOrganizationRole(repositories);

    await syncStaticPermissionCatalog(repositories, silentLogger);

    // El recurso ORGANIZATION y su permiso siguen ahí: el catálogo no gobierna ese recurso.
    expect(
      repositories.resources.rows.some(
        (resource) => resource.key === 'ORGANIZATION',
      ),
    ).toBe(true);
    expect(
      repositories.permissions.rows.some(
        (permission) => permission.id === 'permission-organization-read-any',
      ),
    ).toBe(true);
    // La asignación de ADMIN sobre ORGANIZATION es la que usan hoy los checks de `account`.
    expect(
      repositories.rolePermissions.rows.some(
        (grant) => grant.id === 'grant-admin-organization-read-any',
      ),
    ).toBe(true);
    // DOCUMENT+UPDATE es del recurso del catálogo, pero de una acción que el catálogo no
    // redefine: se preserva igual.
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

  it('reutiliza el recurso y las acciones que ya existían, sin recrearlos', async () => {
    const repositories = createRepositories();
    seedLegacyGrid(repositories);

    const summary = await syncStaticPermissionCatalog(
      repositories,
      silentLogger,
    );

    expect(summary.resources.created).toBe(1); // sólo MEMBER
    expect(summary.resources.reused).toBe(1); // DOCUMENT ya estaba
    expect(summary.actions.created).toBe(4); // SEND_SIGNATURE_REQUEST, SIGN, APPROVE, INVITE
    expect(summary.actions.reused).toBe(2); // CREATE y READ ya estaban
    expect(
      repositories.resources.rows.filter(
        (resource) => resource.key === 'DOCUMENT',
      ),
    ).toHaveLength(1);
  });

  it('corrige la descripción de un recurso del catálogo si cambió', async () => {
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
    ).toBe('Documentos para firma electrónica');
  });

  it('detecta la lectura global heredada de MEMBER pero no la borra por defecto', async () => {
    const repositories = createRepositories();
    seedLegacyGrid(repositories);

    const summary = await syncStaticPermissionCatalog(
      repositories,
      silentLogger,
    );

    // Las dos asignaciones a DOCUMENT+READ+ANY (ADMIN y MEMBER); DOCUMENT+UPDATE+ANY no cuenta.
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
    // ADMIN conserva lo que el catálogo no redefine: DOCUMENT+UPDATE y todo ORGANIZATION.
    expect(grantedPermissionsOf(repositories, 'ADMIN')).toEqual(
      [...ADMIN_MATRIX, 'DOCUMENT.UPDATE.ANY', 'ORGANIZATION.READ.ANY'].sort(),
    );
    // El rol custom no es de sistema: el barrido ni lo mira, aunque apunte al permiso revocado.
    expect(
      repositories.rolePermissions.rows.some(
        (grant) => grant.id === 'grant-custom',
      ),
    ).toBe(true);
  });
});
