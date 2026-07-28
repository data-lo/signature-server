import {
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { RoleEntity } from './entities/role.entity';
import { RolePermissionEntity } from './entities/role-permission.entity';
import { BaseResponse } from 'src/interfaces/api-response.dto';
import { RoleData } from './interfaces/response/role-response';
import { SYSTEM_ROLE_NAME_ENUM } from './enums/system-role-name.enum';
import { RESOURCE_KEY_ENUM } from './enums/resource-key.enum';
import { ACTION_KEY_ENUM } from './enums/action-key.enum';

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

  async findAllSystemRoles(): Promise<BaseResponse<RoleData[]>> {
    const roles = await this.roleRepository.find({
      where: { isSystemRole: true },
      order: { name: 'ASC' },
    });

    return {
      success: true,
      message: 'Roles del sistema obtenidos correctamente',
      data: roles.map((role) => ({
        id: role.id,
        name: role.name,
        isSystemRole: role.isSystemRole,
      })),
    };
  }
}
