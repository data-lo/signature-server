import { Injectable } from '@nestjs/common';

import { BaseResponse } from 'src/interfaces/api-response.dto';
import { ACTION_KEY_ENUM } from 'src/roles/enums/action-key.enum';

import { MemberPermissionsData } from '../interfaces/response/organization-permission-response';
import { OrganizationPermissionsService } from '../organization-permissions.service';

/**
 * Fija los permisos de un miembro
 * (`PATCH /api/v1/organizations/members/:accountId/permissions`).
 *
 * Es un reemplazo total y no una suma: la lista que llega pasa a ser la lista completa del miembro,
 * y una vacía se los quita todos. Es lo que espera una pantalla que envía el estado de sus casillas,
 * y evita un endpoint aparte para revocar.
 *
 * Colapsa los ids repetidos antes de tocar la base: la tabla de asignaciones los aceptaría dos veces
 * y el miembro terminaría con filas duplicadas del mismo permiso.
 */
@Injectable()
export class AssignMemberPermissionsUseCase {
  constructor(
    private readonly organizationPermissionsService: OrganizationPermissionsService,
  ) {}

  async execute(
    callerId: string,
    accountId: string,
    permissionIds: string[],
  ): Promise<BaseResponse<MemberPermissionsData>> {
    const member =
      await this.organizationPermissionsService.findMemberOrFail(accountId);
    const organizationId = member.organizationId as string;

    await this.organizationPermissionsService.assertHasOrganizationPermission(
      callerId,
      organizationId,
      ACTION_KEY_ENUM.UPDATE,
    );

    const uniquePermissionIds = Array.from(new Set(permissionIds));

    await this.organizationPermissionsService.assertPermissionsBelongToOrganization(
      uniquePermissionIds,
      organizationId,
    );

    await this.organizationPermissionsService.replaceMemberPermissions(
      accountId,
      uniquePermissionIds,
    );

    return {
      success: true,
      message: 'Permisos del miembro actualizados correctamente',
      data: { accountId, permissionIds: uniquePermissionIds },
    };
  }
}
