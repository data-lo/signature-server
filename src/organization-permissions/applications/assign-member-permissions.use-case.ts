import { Injectable } from '@nestjs/common';

import { BaseResponse } from 'src/interfaces/api-response.dto';
import { ACTION_KEY_ENUM } from 'src/roles/enums/action-key.enum';

import { MemberPermissionsData } from '../interfaces/response/organization-permission-response';
import { OrganizationPermissionsService } from '../organization-permissions.service';

/**
 * `PATCH /api/v1/organizations/members/:accountId/permissions`: fija los permisos de un miembro.
 *
 * Es un reemplazo total, no una suma: la lista que llega pasa a ser la lista completa del
 * miembro, y una lista vacía le quita todos. Eso es lo que espera una pantalla que envía el
 * estado de sus casillas, y evita necesitar un endpoint aparte para revocar.
 *
 * Los ids repetidos se colapsan antes de tocar la base: la tabla de asignaciones los aceptaría
 * dos veces y el miembro terminaría con filas duplicadas del mismo permiso.
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
