import { Injectable } from '@nestjs/common';

import { BaseResponse } from 'src/interfaces/api-response.dto';
import { ACTION_KEY_ENUM } from 'src/roles/enums/action-key.enum';

import { MemberPermissionsData } from '../interfaces/response/organization-permission-response';
import { OrganizationPermissionsService } from '../organization-permissions.service';

/**
 * `GET /api/v1/organizations/members/:accountId/permissions`: qué permisos del catálogo tiene
 * asignados un miembro.
 *
 * La organización no viene en la ruta: se deduce de la propia membresía y sólo después se
 * comprueba que el llamador administre esa organización. Tomarla de un parámetro dejaría que
 * quien administra la organización A consultara a un miembro de la B pasando su propio
 * `organizationId`.
 */
@Injectable()
export class GetMemberPermissionsUseCase {
  constructor(
    private readonly organizationPermissionsService: OrganizationPermissionsService,
  ) {}

  async execute(
    callerId: string,
    accountId: string,
  ): Promise<BaseResponse<MemberPermissionsData>> {
    const member =
      await this.organizationPermissionsService.findMemberOrFail(accountId);

    await this.organizationPermissionsService.assertHasOrganizationPermission(
      callerId,
      member.organizationId as string,
      ACTION_KEY_ENUM.READ,
    );

    return {
      success: true,
      message: 'Permisos del miembro obtenidos correctamente',
      data: {
        accountId,
        permissionIds:
          await this.organizationPermissionsService.findMemberPermissionIds(
            accountId,
          ),
      },
    };
  }
}
