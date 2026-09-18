import { Injectable } from '@nestjs/common';

import { BaseResponse } from 'src/interfaces/api-response.dto';
import { UpdateOrganizationRoleDto } from '../dto/update-organization-role.dto';
import { RoleData } from '../interfaces/response/role-response';
import { RolesService } from '../roles.service';

/**
 * `PATCH /api/v1/organizations/:organizationId/roles/:roleId`: renombra y/o reemplaza los
 * permisos de un rol propio de la organización. Los roles de sistema (ADMIN/MEMBER) o de otra
 * organización responden 404 — ver `RolesService.updateOrganizationRole`.
 */
@Injectable()
export class UpdateOrganizationRoleUseCase {
  constructor(private readonly rolesService: RolesService) {}

  async execute(
    callerId: string,
    organizationId: string,
    roleId: string,
    dto: UpdateOrganizationRoleDto,
  ): Promise<BaseResponse<RoleData>> {
    /**
     * Sin comprobación de permisos aquí: la hace `PermissionsGuard` a partir del
     * `@RequirePermission(ROLE, MANAGE)` del controller, que además exige el permiso propio
     * del recurso (`ROLE.MANAGE`) en vez del genérico `ORGANIZATION.UPDATE` que se usaba
     * antes. El caso de uso ya sólo coordina la operación.
     */
    const role = await this.rolesService.updateOrganizationRole(
      organizationId,
      roleId,
      { name: dto.name, permissionKeys: dto.permissionKeys },
    );
    const permissionsByRole = await this.rolesService.listPermissionsByRoleIds([
      role.id,
    ]);

    return {
      success: true,
      message: 'Rol actualizado correctamente',
      data: {
        id: role.id,
        name: role.name,
        isSystemRole: role.isSystemRole,
        permissions: permissionsByRole.get(role.id) ?? [],
        createdAt: role.createdAt,
      },
    };
  }
}
