import {
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { RoleEntity } from './entities/role.entity';
import { RolePermissionEntity } from './entities/role-permission.entity';
import { SYSTEM_ROLE_NAME_ENUM } from './enums/system-role-name.enum';
import { RESOURCE_KEY_ENUM } from './enums/resource-key.enum';
import { ACTION_KEY_ENUM } from './enums/action-key.enum';
import { RolePermissionData } from './interfaces/response/permission-response';
import {
  comparePermissionKeys,
  toPermissionData,
} from './permission-catalog.util';

@Injectable()
export class RolesService {
  constructor(
    @InjectRepository(RoleEntity)
    private readonly roleRepository: Repository<RoleEntity>,

    @InjectRepository(RolePermissionEntity)
    private readonly rolePermissionRepository: Repository<RolePermissionEntity>,
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
}
