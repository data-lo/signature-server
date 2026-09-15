import { Injectable } from '@nestjs/common';

import { BaseResponse } from 'src/interfaces/api-response.dto';
import { ACTION_KEY_ENUM } from '../enums/action-key.enum';
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
    await this.rolesService.assertHasOrganizationPermission(
      callerId,
      organizationId,
      ACTION_KEY_ENUM.READ,
    );

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
