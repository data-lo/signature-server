import {
  ConflictException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Repository } from 'typeorm';
import { AccountEntity } from 'src/account/entities/account.entity';
import { RoleEntity } from './entities/role.entity';
import { RolePermissionEntity } from './entities/role-permission.entity';
import { PermissionEntity } from './entities/permission.entity';
import { SYSTEM_ROLE_NAME_ENUM } from './enums/system-role-name.enum';
import { RESOURCE_KEY_ENUM } from './enums/resource-key.enum';
import { ACTION_KEY_ENUM } from './enums/action-key.enum';
import { RolePermissionData } from './interfaces/response/permission-response';
import {
  buildPermissionKey,
  comparePermissionKeys,
  toPermissionData,
} from './permission-catalog.util';
import {
  STATIC_PERMISSION_CATALOG,
  STATIC_PERMISSION_KEY_ENUM,
} from './static-permission-catalog';

@Injectable()
export class RolesService {
  constructor(
    @InjectRepository(RoleEntity)
    private readonly roleRepository: Repository<RoleEntity>,

    @InjectRepository(RolePermissionEntity)
    private readonly rolePermissionRepository: Repository<RolePermissionEntity>,

    @InjectRepository(PermissionEntity)
    private readonly permissionRepository: Repository<PermissionEntity>,

    @InjectRepository(AccountEntity)
    private readonly accountRepository: Repository<AccountEntity>,

    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  /**
   * Resuelve un rol del sistema por nombre (ADMIN/MEMBER). Se usa al asignar
   * el rol por defecto de una membresía nueva (cuenta personal, organización).
   * Si falta (el seed `npm run seed:roles` no se ha corrido) falla con un
   * error claro en vez de dejar la membresía sin rol silenciosamente.
   */
  async findSystemRoleByName(name: SYSTEM_ROLE_NAME_ENUM): Promise<RoleEntity> {
    const role = await this.roleRepository.findOne({
      where: { name, isSystemRole: true },
    });

    if (!role) {
      throw new InternalServerErrorException(
        `El rol de sistema ${name} no está sembrado. Corre "npm run seed:roles".`,
      );
    }

    return role;
  }

  /**
   * Resuelve un rol que una organización puede asignar a sus miembros: uno del sistema
   * (ADMIN/MEMBER) o uno propio de esa misma organización.
   *
   * Un rol de OTRA organización se trata como inexistente en vez de como prohibido: quien
   * administra una organización no tiene por qué saber qué roles existen en las demás, y
   * distinguir "no existe" de "no es tuyo" filtraría justamente eso.
   *
   * @param roleId - Identificador del rol que se quiere asignar.
   * @param organizationId - Organización activa desde la que se asigna.
   * @returns El rol, listo para asignarse a una membresía de esa organización.
   *
   * @throws {NotFoundException} Si el rol no existe, o existe pero pertenece a otra organización.
   *
   * @example
   * ```ts
   * const role = await rolesService.findAssignableRoleOrFail(dto.roleId, 'org-1');
   * ```
   */
  async findAssignableRoleOrFail(
    roleId: string,
    organizationId: string,
  ): Promise<RoleEntity> {
    const role = await this.roleRepository.findOne({ where: { id: roleId } });

    const belongsToAnotherOrganization =
      !!role &&
      !role.isSystemRole &&
      role.organizationId !== null &&
      role.organizationId !== organizationId;

    if (!role || belongsToAnotherOrganization) {
      throw new NotFoundException(
        `Rol con ID ${roleId} no encontrado para esta organización`,
      );
    }

    return role;
  }

  /**
   * Permisos que otorga cada uno de los roles pedidos, agrupados por rol.
   *
   * Se resuelve en UNA consulta para todos los roles en vez de una por rol: la tabla de miembros
   * pide los permisos de cada fila y hacerlo de a uno multiplicaría las consultas por el número
   * de miembros. Los permisos vienen ordenados con el catálogo estático primero (ver
   * `comparePermissionKeys`), que es el orden en que la pantalla los lista.
   *
   * @param roleIds - Identificadores de rol a resolver; los repetidos se consultan una sola vez.
   * @returns Un mapa `roleId → permisos`. Un rol sin permisos no aparece en el mapa.
   *
   * @throws {QueryFailedError} Si la consulta contra Postgres falla.
   *
   * @example
   * ```ts
   * const byRole = await rolesService.listPermissionsByRoleIds(['role-1', 'role-2']);
   * const adminPermissions = byRole.get('role-1') ?? [];
   * ```
   */
  async listPermissionsByRoleIds(
    roleIds: string[],
  ): Promise<Map<string, RolePermissionData[]>> {
    const uniqueRoleIds = [...new Set(roleIds)];
    const grouped = new Map<string, RolePermissionData[]>();

    // `In([])` genera SQL inválido en TypeORM, y de todas formas no hay nada que consultar.
    if (uniqueRoleIds.length === 0) return grouped;

    const grants = await this.rolePermissionRepository.find({
      where: { roleId: In(uniqueRoleIds) },
      relations: { permission: { resource: true, action: true } },
    });

    for (const grant of grants) {
      const permissions = grouped.get(grant.roleId) ?? [];
      permissions.push(toPermissionData(grant.permission));
      grouped.set(grant.roleId, permissions);
    }

    for (const permissions of grouped.values()) {
      permissions.sort((first, second) =>
        comparePermissionKeys(first.key, second.key),
      );
    }

    return grouped;
  }

  /** Verifica que un roleId exista (usado al validar el body de account-member). */
  async findByIdOrFail(id: string): Promise<RoleEntity> {
    const role = await this.roleRepository.findOne({ where: { id } });

    if (!role) {
      throw new NotFoundException(`Rol con ID ${id} no encontrado`);
    }

    return role;
  }

  /**
   * Consulta granular real contra `role_permissions` (resource+action), en vez de comparar un
   * nombre de rol fijo (`role.name === 'ADMIN'`) como hacían los checks de autorización hasta
   * ahora. El seed (`npm run seed:roles`) le da a ADMIN los 12 permisos (3 resources × 4
   * actions) y a MEMBER solo DOCUMENT:READ/CREATE, así que reemplazar un check "es ADMIN" por
   * "tiene el permiso X" no cambia el comportamiento actual — pero sí permite que un futuro rol
   * custom de organización con permisos parciales funcione sin tocar el código que llama esto.
   *
   * **Ignora el `scope`**: pregunta por resource+action y acepta cualquier alcance. Con la
   * rejilla de `seed:roles` (todo `ANY`) daba igual, pero el catálogo de permisos estáticos
   * (`npm run seed:static-permissions`, ver `src/roles/static-permission-catalog.ts`) ya
   * distingue `OWN` de `ORGANIZATION`, así que quien necesite esa diferencia tendrá que
   * consultar también el alcance — es parte del ticket de RBAC efectivo, no de la carga del
   * catálogo, y hoy ninguna ruta pregunta por permisos de DOCUMENT.
   */
  async hasPermission(
    roleId: string | null | undefined,
    resourceKey: RESOURCE_KEY_ENUM,
    actionKey: ACTION_KEY_ENUM,
  ): Promise<boolean> {
    if (!roleId) return false;

    const match = await this.rolePermissionRepository.findOne({
      where: {
        roleId,
        permission: {
          resource: { key: resourceKey },
          action: { key: actionKey },
        },
      },
      relations: { permission: { resource: true, action: true } },
    });

    return !!match;
  }

  async assertHasPermission(
    roleId: string | null | undefined,
    resourceKey: RESOURCE_KEY_ENUM,
    actionKey: ACTION_KEY_ENUM,
    message?: string,
  ): Promise<void> {
    const allowed = await this.hasPermission(roleId, resourceKey, actionKey);
    if (!allowed) {
      throw new ForbiddenException(
        message ?? 'No tienes permisos suficientes para realizar esta acción',
      );
    }
  }

  /** Roles de sistema (ADMIN/MEMBER) ordenados por nombre, para el catálogo público de roles. */
  async listSystemRoles(): Promise<RoleEntity[]> {
    return this.roleRepository.find({
      where: { isSystemRole: true },
      order: { name: 'ASC' },
    });
  }

  /**
   * Solo un miembro activo con permiso ORGANIZATION:{action} (rol ADMIN) puede gestionar los
   * roles de su organización — mismo criterio y mismo texto que
   * `AccountMemberService.assertHasOrganizationPermission`, duplicado aquí porque este servicio
   * resuelve la membresía del llamador de forma independiente (mismo patrón ya usado en
   * `AccountService`/`OrganizationPermissionsService`: no vale la pena un import cruzado de
   * módulo — `AccountModule` ya importa `RolesModule`, directo y a través de
   * `OrganizationPermissionsModule` — sólo para esta comprobación de una fila).
   */
  async assertHasOrganizationPermission(
    callerId: string,
    organizationId: string,
    action: ACTION_KEY_ENUM,
  ): Promise<void> {
    const callerMembership = await this.accountRepository.findOne({
      where: { userId: callerId, organizationId, isActive: true },
      relations: { role: true },
    });

    await this.assertHasPermission(
      callerMembership?.roleId,
      RESOURCE_KEY_ENUM.ORGANIZATION,
      action,
      'No tienes permisos de administrador sobre esta organización',
    );
  }

  /**
   * Roles visibles para una organización: los de sistema (ADMIN/MEMBER, de solo lectura en la
   * pantalla) más los propios de esa organización. El `where` en arreglo es un OR en TypeORM.
   */
  async listOrganizationRoles(organizationId: string): Promise<RoleEntity[]> {
    return this.roleRepository.find({
      where: [{ isSystemRole: true }, { organizationId }],
      order: { name: 'ASC' },
    });
  }

  /**
   * Crea un rol propio de una organización con los permisos del catálogo estático que se le
   * pidan (un arreglo vacío es válido: un rol sin capacidades todavía, editable después).
   *
   * @throws {ConflictException} Si el nombre coincide con un rol de sistema o con otro rol ya
   *   existente en la misma organización.
   * @throws {InternalServerErrorException} Si alguna clave del catálogo estático no resuelve a
   *   una fila de `permissions` (el seed `npm run seed:static-permissions` no se ha corrido).
   */
  async createOrganizationRole(
    organizationId: string,
    name: string,
    permissionKeys: STATIC_PERMISSION_KEY_ENUM[],
  ): Promise<RoleEntity> {
    await this.assertRoleNameAvailable(organizationId, name);
    const permissionIds = await this.resolveStaticPermissionIds(permissionKeys);

    const role = await this.roleRepository.save(
      this.roleRepository.create({
        name,
        isSystemRole: false,
        organizationId,
      }),
    );

    if (permissionIds.length > 0) {
      await this.rolePermissionRepository.insert(
        permissionIds.map((permissionId) => ({
          roleId: role.id,
          permissionId,
        })),
      );
    }

    return role;
  }

  /**
   * Edita el nombre y/o los permisos de un rol propio de una organización. Los permisos, cuando
   * llegan, REEMPLAZAN el set completo (no se agregan) — mismo criterio que
   * `OrganizationPermissionsService.replaceMemberPermissions`.
   *
   * @throws {NotFoundException} Si el rol no existe, es de otra organización, o es un rol de
   *   sistema (ADMIN/MEMBER no se editan) — el mismo trato de "inexistente" que ya usa
   *   `findAssignableRoleOrFail`, para no filtrar qué roles existen en otras organizaciones.
   * @throws {ConflictException} Si el nuevo nombre choca con un rol de sistema o con otro rol de
   *   la misma organización.
   */
  async updateOrganizationRole(
    organizationId: string,
    roleId: string,
    changes: {
      name?: string;
      permissionKeys?: STATIC_PERMISSION_KEY_ENUM[];
    },
  ): Promise<RoleEntity> {
    const role = await this.findCustomRoleOrFail(organizationId, roleId);

    if (changes.name !== undefined && changes.name !== role.name) {
      await this.assertRoleNameAvailable(organizationId, changes.name, roleId);
      role.name = changes.name;
      await this.roleRepository.save(role);
    }

    if (changes.permissionKeys !== undefined) {
      const permissionIds = await this.resolveStaticPermissionIds(
        changes.permissionKeys,
      );

      await this.dataSource.transaction(async (manager) => {
        const repository = manager.getRepository(RolePermissionEntity);
        await repository.delete({ roleId });

        if (permissionIds.length > 0) {
          await repository.insert(
            permissionIds.map((permissionId) => ({ roleId, permissionId })),
          );
        }
      });
    }

    return role;
  }

  /** Un rol propio de ESA organización, nunca uno de sistema. Ver `updateOrganizationRole`. */
  private async findCustomRoleOrFail(
    organizationId: string,
    roleId: string,
  ): Promise<RoleEntity> {
    const role = await this.roleRepository.findOne({ where: { id: roleId } });

    if (!role || role.isSystemRole || role.organizationId !== organizationId) {
      throw new NotFoundException(
        `Rol con ID ${roleId} no encontrado para esta organización`,
      );
    }

    return role;
  }

  /**
   * El nombre no puede repetir el de un rol de sistema (evita un rol custom literalmente llamado
   * "ADMIN") ni el de otro rol ya existente en la misma organización. La constraint única
   * `(organization_id, name)` de la migración es el respaldo real contra una condición de
   * carrera entre esta comprobación y el `insert`; esto es sólo el mensaje claro para el caso
   * normal.
   */
  private async assertRoleNameAvailable(
    organizationId: string,
    name: string,
    excludeRoleId?: string,
  ): Promise<void> {
    if ((Object.values(SYSTEM_ROLE_NAME_ENUM) as string[]).includes(name)) {
      throw new ConflictException(
        `Ya existe un rol de sistema llamado "${name}"`,
      );
    }

    const existing = await this.roleRepository.findOne({
      where: { organizationId, name },
    });

    if (existing && existing.id !== excludeRoleId) {
      throw new ConflictException(
        `Ya existe un rol llamado "${name}" en esta organización`,
      );
    }
  }

  /**
   * Traduce claves del catálogo estático (`DOCUMENT.CREATE`, ...) a los ids de `permissions` que
   * de verdad se guardan en `role_permissions`. Una sola consulta y filtrado en memoria, mismo
   * estilo que `listPermissionsByRoleIds`.
   *
   * @throws {InternalServerErrorException} Si alguna clave no resuelve — el seed de permisos
   *   estáticos no se ha corrido.
   */
  private async resolveStaticPermissionIds(
    keys: STATIC_PERMISSION_KEY_ENUM[],
  ): Promise<string[]> {
    if (keys.length === 0) return [];

    const allPermissions = await this.permissionRepository.find({
      relations: { resource: true, action: true },
    });

    return keys.map((key) => {
      const definition = STATIC_PERMISSION_CATALOG[key];
      const match = allPermissions.find(
        (permission) =>
          buildPermissionKey(
            permission.resource.key,
            permission.action.key,
            permission.scope,
          ) ===
          buildPermissionKey(
            definition.resource,
            definition.action,
            definition.scope,
          ),
      );

      if (!match) {
        throw new InternalServerErrorException(
          `El permiso ${key} no está sembrado. Corre "npm run seed:static-permissions".`,
        );
      }

      return match.id;
    });
  }
}
