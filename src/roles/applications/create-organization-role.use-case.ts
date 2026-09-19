import { Injectable } from '@nestjs/common';

import { BaseResponse } from 'src/interfaces/api-response.dto';
import { CreateOrganizationRoleDto } from '../dto/create-organization-role.dto';
import { RoleData } from '../interfaces/response/role-response';
import { RolesService } from '../roles.service';

/**
 * `POST /api/v1/organizations/:organizationId/roles`: crea un rol propio de la organización con
 * permisos del catálogo estático (historia "Reemplazar 'Permisos' por 'Roles y permisos'").
 */
@Injectable()
export class CreateOrganizationRoleUseCase {
  constructor(private readonly rolesService: RolesService) {}

  async execute(
    callerId: string,
    organizationId: string,
    dto: CreateOrganizationRoleDto,
  ): Promise<BaseResponse<RoleData>> {
    /**
     * Sin comprobación de permisos aquí: la hace `PermissionsGuard` a partir del
     * `@RequirePermission(ROLE, MANAGE)` del controller, que además exige el permiso propio
     * del recurso (`ROLE.MANAGE`) en vez del genérico `ORGANIZATION.CREATE` que se usaba
     * antes. El caso de uso ya sólo coordina la operación.
     */
    const role = await this.rolesService.createOrganizationRole(
      organizationId,
      dto.name,
      dto.permissionKeys,
    );
    const permissionsByRole = await this.rolesService.listPermissionsByRoleIds([
      role.id,
    ]);

    return {
      success: true,
      message: 'Rol creado correctamente',
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
