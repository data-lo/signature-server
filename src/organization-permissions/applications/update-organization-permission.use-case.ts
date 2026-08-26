import { Injectable } from '@nestjs/common';

import { BaseResponse } from 'src/interfaces/api-response.dto';
import { ACTION_KEY_ENUM } from 'src/roles/enums/action-key.enum';

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
    await this.organizationPermissionsService.assertHasOrganizationPermission(
      callerId,
      organizationId,
      ACTION_KEY_ENUM.UPDATE,
    );

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
