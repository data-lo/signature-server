import { Injectable } from '@nestjs/common';

import { BaseResponse } from 'src/interfaces/api-response.dto';
import { ACTION_KEY_ENUM } from 'src/roles/enums/action-key.enum';

import { CreateOrganizationPermissionDto } from '../dto/create-organization-permission.dto';
import { OrganizationPermissionData } from '../interfaces/response/organization-permission-response';
import { OrganizationPermissionsService } from '../organization-permissions.service';

/**
 * `POST /api/v1/organizations/:organizationId/permissions`: agrega un permiso al catálogo de la
 * organización.
 *
 * El nombre se comprueba antes de guardar porque la tabla tiene un índice único por
 * organización y nombre: dejar que reviente la restricción daría un 500 genérico en lugar de un
 * 409 que le dice al administrador que ese nombre ya lo usó.
 */
@Injectable()
export class CreateOrganizationPermissionUseCase {
  constructor(
    private readonly organizationPermissionsService: OrganizationPermissionsService,
  ) {}

  async execute(
    callerId: string,
    organizationId: string,
    dto: CreateOrganizationPermissionDto,
  ): Promise<BaseResponse<OrganizationPermissionData>> {
    await this.organizationPermissionsService.assertHasOrganizationPermission(
      callerId,
      organizationId,
      ACTION_KEY_ENUM.CREATE,
    );

    await this.organizationPermissionsService.assertNameNotTaken(
      organizationId,
      dto.name,
    );

    return {
      success: true,
      message: 'Permiso creado correctamente',
      data: await this.organizationPermissionsService.savePermission(
        organizationId,
        dto.name,
      ),
    };
  }
}
