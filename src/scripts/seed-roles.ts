import 'reflect-metadata';
import * as dotenv from 'dotenv';
dotenv.config();

import { join } from 'path';
import { DataSource } from 'typeorm';

import { RoleEntity } from '../roles/entities/role.entity';
import { ResourceEntity } from '../roles/entities/resource.entity';
import { ActionEntity } from '../roles/entities/action.entity';
import { PermissionEntity } from '../roles/entities/permission.entity';
import { RolePermissionEntity } from '../roles/entities/role-permission.entity';
import { SYSTEM_ROLE_NAME_ENUM } from '../roles/enums/system-role-name.enum';
import { RESOURCE_KEY_ENUM } from '../roles/enums/resource-key.enum';
import { ACTION_KEY_ENUM } from '../roles/enums/action-key.enum';
import { PERMISSION_SCOPE_ENUM } from '../roles/enums/permission-scope.enum';

/**
 * Puebla las tablas estáticas del RBAC básico (roles, resources, actions,
 * permissions, role_permissions). Se puede correr varias veces sin duplicar
 * registros: cada entidad se busca por su clave natural (key/name, o el par
 * resourceId+actionId+scope / roleId+permissionId para las tablas pivote)
 * antes de insertarla.
 */

const RESOURCE_DESCRIPTIONS: Record<RESOURCE_KEY_ENUM, string> = {
  [RESOURCE_KEY_ENUM.DOCUMENT]: 'Documentos para firma electrónica',
  [RESOURCE_KEY_ENUM.ORGANIZATION]: 'Cuentas de tipo organización',
  [RESOURCE_KEY_ENUM.USER]: 'Usuarios de la plataforma',
};

const ACTION_DESCRIPTIONS: Record<ACTION_KEY_ENUM, string> = {
  [ACTION_KEY_ENUM.CREATE]: 'Crear un recurso nuevo',
  [ACTION_KEY_ENUM.READ]: 'Consultar un recurso existente',
  [ACTION_KEY_ENUM.UPDATE]: 'Actualizar un recurso existente',
  [ACTION_KEY_ENUM.DELETE]: 'Eliminar un recurso existente',
};

async function upsertRole(
  dataSource: DataSource,
  name: SYSTEM_ROLE_NAME_ENUM,
): Promise<RoleEntity> {
  const roleRepository = dataSource.getRepository(RoleEntity);
  const existing = await roleRepository.findOne({
    where: { name, isSystemRole: true },
  });
  if (existing) return existing;

  return roleRepository.save(
    roleRepository.create({ name, isSystemRole: true, organizationId: null }),
  );
}

async function upsertResource(
  dataSource: DataSource,
  key: RESOURCE_KEY_ENUM,
): Promise<ResourceEntity> {
  const resourceRepository = dataSource.getRepository(ResourceEntity);
  const existing = await resourceRepository.findOne({ where: { key } });
  if (existing) return existing;

  return resourceRepository.save(
    resourceRepository.create({ key, description: RESOURCE_DESCRIPTIONS[key] }),
  );
}

async function upsertAction(
  dataSource: DataSource,
  key: ACTION_KEY_ENUM,
): Promise<ActionEntity> {
  const actionRepository = dataSource.getRepository(ActionEntity);
  const existing = await actionRepository.findOne({ where: { key } });
  if (existing) return existing;

  return actionRepository.save(
    actionRepository.create({ key, description: ACTION_DESCRIPTIONS[key] }),
  );
}

async function upsertPermission(
  dataSource: DataSource,
  resource: ResourceEntity,
  action: ActionEntity,
  scope: PERMISSION_SCOPE_ENUM,
): Promise<PermissionEntity> {
  const permissionRepository = dataSource.getRepository(PermissionEntity);
  const existing = await permissionRepository.findOne({
    where: { resourceId: resource.id, actionId: action.id, scope },
  });
  if (existing) return existing;

  return permissionRepository.save(
    permissionRepository.create({
      resourceId: resource.id,
      actionId: action.id,
      scope,
    }),
  );
}

async function upsertRolePermission(
  dataSource: DataSource,
  role: RoleEntity,
  permission: PermissionEntity,
): Promise<void> {
  const rolePermissionRepository =
    dataSource.getRepository(RolePermissionEntity);
  const existing = await rolePermissionRepository.findOne({
    where: { roleId: role.id, permissionId: permission.id },
  });
  if (existing) return;

  await rolePermissionRepository.save(
    rolePermissionRepository.create({
      roleId: role.id,
      permissionId: permission.id,
    }),
  );
}

async function main() {
  const dataSource = new DataSource({
    type: 'postgres',
    url: process.env.POSTGRES_DB_URL,
    // Glob doble extensión: en dev corre vía ts-node sobre src/**/*.entity.ts, en
    // Docker/producción corre con `node` directo sobre dist/**/*.entity.js (ver DoD del
    // ticket de seeding post-build) — __dirname apunta a la carpeta real en ambos casos, así
    // que un solo glob cubre los dos entornos sin necesidad de una variable de entorno aparte.
    entities: [join(process.cwd(), 'dist', '**', '*.entity.js')],
    synchronize: false,
    logging: false,
  });

  await dataSource.initialize();
  console.log('Conectado a la base de datos.');

  console.log('Creando/verificando roles del sistema...');
  const adminRole = await upsertRole(dataSource, SYSTEM_ROLE_NAME_ENUM.ADMIN);
  const memberRole = await upsertRole(dataSource, SYSTEM_ROLE_NAME_ENUM.MEMBER);

  console.log('Creando/verificando resources...');
  const resources = new Map<RESOURCE_KEY_ENUM, ResourceEntity>();
  for (const key of Object.values(RESOURCE_KEY_ENUM)) {
    resources.set(key, await upsertResource(dataSource, key));
  }

  console.log('Creando/verificando actions...');
  const actions = new Map<ACTION_KEY_ENUM, ActionEntity>();
  for (const key of Object.values(ACTION_KEY_ENUM)) {
    actions.set(key, await upsertAction(dataSource, key));
  }

  console.log('Creando/verificando permissions y role_permissions...');

  // ADMIN: todas las acciones sobre todos los recursos.
  for (const resource of resources.values()) {
    for (const action of actions.values()) {
      const permission = await upsertPermission(
        dataSource,
        resource,
        action,
        PERMISSION_SCOPE_ENUM.ANY,
      );
      await upsertRolePermission(dataSource, adminRole, permission);
    }
  }

  // MEMBER: solo READ y CREATE sobre DOCUMENT.
  const documentResource = resources.get(RESOURCE_KEY_ENUM.DOCUMENT)!;
  for (const actionKey of [ACTION_KEY_ENUM.READ, ACTION_KEY_ENUM.CREATE]) {
    const permission = await upsertPermission(
      dataSource,
      documentResource,
      actions.get(actionKey)!,
      PERMISSION_SCOPE_ENUM.ANY,
    );
    await upsertRolePermission(dataSource, memberRole, permission);
  }

  await dataSource.destroy();
  console.log(
    'Listo. RBAC básico sembrado (roles, resources, actions, permissions).',
  );
}

main().catch((error) => {
  console.error('Error sembrando el RBAC básico:', error);
  process.exit(1);
});
