import { Injectable } from '@nestjs/common';

import { BaseResponse } from 'src/interfaces/api-response.dto';

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
    /**
     * Sin comprobación de permisos aquí: la hace `PermissionsGuard` con el
     * `@RequirePermission(ORGANIZATION, UPDATE)` del controller. El catálogo estático no
     * distingue CREATE ni DELETE sobre la organización —sus dos permisos son `ORGANIZATION.READ`
     * y `ORGANIZATION.UPDATE`—, y el catálogo de permisos de organización es precisamente
     * configuración suya, así que crear, editar y borrar entradas caen todas bajo `UPDATE`.
     */
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
