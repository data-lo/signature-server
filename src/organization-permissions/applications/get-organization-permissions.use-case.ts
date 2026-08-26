import { Injectable } from '@nestjs/common';

import { BaseResponse } from 'src/interfaces/api-response.dto';
import { ACTION_KEY_ENUM } from 'src/roles/enums/action-key.enum';

import { OrganizationPermissionData } from '../interfaces/response/organization-permission-response';
import { OrganizationPermissionsService } from '../organization-permissions.service';

/**
 * `GET /api/v1/organizations/:organizationId/permissions`: catálogo de permisos de una
 * organización.
 *
 * Aunque sea una lectura exige ser administrador activo de esa organización: el catálogo dice
 * cómo está repartido el control interno, y quien no administra la organización no tiene por
 * qué poder enumerarlo.
 */
@Injectable()
export class GetOrganizationPermissionsUseCase {
  constructor(
    private readonly organizationPermissionsService: OrganizationPermissionsService,
  ) {}

  async execute(
    callerId: string,
    organizationId: string,
  ): Promise<BaseResponse<OrganizationPermissionData[]>> {
    await this.organizationPermissionsService.assertHasOrganizationPermission(
      callerId,
      organizationId,
      ACTION_KEY_ENUM.READ,
    );

    return {
      success: true,
      message: 'Permisos obtenidos correctamente',
      data: await this.organizationPermissionsService.listForOrganization(
        organizationId,
      ),
    };
  }
}
