import { Injectable } from '@nestjs/common';

import { BaseResponse } from 'src/interfaces/api-response.dto';
import { RoleData } from '../interfaces/response/role-response';
import { RolesService } from '../roles.service';

/**
 * `GET /api/v1/organizations/:organizationId/roles`: catálogo de roles visibles para una
 * organización — los de sistema (ADMIN/MEMBER, de solo lectura en la pantalla) más los propios
 * de esa organización.
 */
@Injectable()
export class ListOrganizationRolesUseCase {
  constructor(private readonly rolesService: RolesService) {}

  async execute(
    callerId: string,
    organizationId: string,
  ): Promise<BaseResponse<RoleData[]>> {
    /**
     * Sin comprobación de permisos aquí: la hace `PermissionsGuard` a partir del
     * `@RequirePermission(ROLE, READ)` del controller, que además exige el permiso propio
     * del recurso (`ROLE.READ`) en vez del genérico `ORGANIZATION.READ` que se usaba
     * antes. El caso de uso ya sólo coordina la operación.
     */
    const roles = await this.rolesService.listOrganizationRoles(organizationId);
    const permissionsByRole = await this.rolesService.listPermissionsByRoleIds(
      roles.map((role) => role.id),
    );

    return {
      success: true,
      message: 'Roles obtenidos correctamente',
      data: roles.map((role) => ({
        id: role.id,
        name: role.name,
        isSystemRole: role.isSystemRole,
        permissions: permissionsByRole.get(role.id) ?? [],
        createdAt: role.createdAt,
      })),
    };
  }
}
