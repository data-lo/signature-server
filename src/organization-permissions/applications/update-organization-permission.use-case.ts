import { Injectable } from '@nestjs/common';

import { BaseResponse } from 'src/interfaces/api-response.dto';

import { UpdateOrganizationPermissionDto } from '../dto/update-organization-permission.dto';
import { OrganizationPermissionData } from '../interfaces/response/organization-permission-response';
import { OrganizationPermissionsService } from '../organization-permissions.service';

/**
 * `PATCH /api/v1/organizations/:organizationId/permissions/:permissionId`: renombra o
 * activa/desactiva un permiso del catálogo.
 *
 * El choque de nombres sólo se comprueba si el nombre efectivamente cambia: mandar el mismo
 * nombre que ya tiene el permiso es una edición legítima —por ejemplo, al cambiar sólo
 * `isActive`— y rechazarla porque "ya existe" sería rechazar el permiso contra sí mismo.
 */
@Injectable()
export class UpdateOrganizationPermissionUseCase {
  constructor(
    private readonly organizationPermissionsService: OrganizationPermissionsService,
  ) {}

  async execute(
    callerId: string,
    organizationId: string,
    permissionId: string,
    dto: UpdateOrganizationPermissionDto,
  ): Promise<BaseResponse<OrganizationPermissionData>> {
    /**
     * Sin comprobación de permisos aquí: la hace `PermissionsGuard` con el
     * `@RequirePermission(ORGANIZATION, UPDATE)` del controller. El catálogo estático no
     * distingue CREATE ni DELETE sobre la organización —sus dos permisos son `ORGANIZATION.READ`
     * y `ORGANIZATION.UPDATE`—, y el catálogo de permisos de organización es precisamente
     * configuración suya, así que crear, editar y borrar entradas caen todas bajo `UPDATE`.
     */
    const permission =
      await this.organizationPermissionsService.findPermissionOrFail(
        organizationId,
        permissionId,
      );

    if (dto.name !== undefined && dto.name !== permission.name) {
      await this.organizationPermissionsService.assertNameNotTaken(
        organizationId,
        dto.name,
      );
    }

    await this.organizationPermissionsService.updatePermission(permission.id, {
      name: dto.name,
      isActive: dto.isActive,
    });

    return {
      success: true,
      message: 'Permiso actualizado correctamente',
      data: await this.organizationPermissionsService.findPermissionOrFail(
        organizationId,
        permissionId,
      ),
    };
  }
}
