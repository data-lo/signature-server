import { Injectable } from '@nestjs/common';

import { BaseResponse } from 'src/interfaces/api-response.dto';
import { ACTION_KEY_ENUM } from 'src/roles/enums/action-key.enum';

import { OrganizationPermissionsService } from '../organization-permissions.service';

/**
 * `DELETE /api/v1/organizations/:organizationId/permissions/:permissionId`: quita un permiso del
 * catálogo.
 *
 * El permiso se resuelve antes de borrar aunque el borrado por id bastaría: así, intentar
 * eliminar un permiso de otra organización da 404 en vez de un borrado silencioso que no afecta
 * a nada y responde éxito.
 */
@Injectable()
export class DeleteOrganizationPermissionUseCase {
  constructor(
    private readonly organizationPermissionsService: OrganizationPermissionsService,
  ) {}

  async execute(
    callerId: string,
    organizationId: string,
    permissionId: string,
  ): Promise<BaseResponse> {
    await this.organizationPermissionsService.assertHasOrganizationPermission(
      callerId,
      organizationId,
      ACTION_KEY_ENUM.DELETE,
    );

    await this.organizationPermissionsService.findPermissionOrFail(
      organizationId,
      permissionId,
    );
    await this.organizationPermissionsService.deletePermission(permissionId);

    return {
      success: true,
      message: 'Permiso eliminado correctamente',
    };
  }
}
