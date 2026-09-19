import { Injectable } from '@nestjs/common';

import { BaseResponse } from 'src/interfaces/api-response.dto';

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
    /**
     * Sin comprobación de permisos aquí: la hace `PermissionsGuard` con el
     * `@RequirePermission(ORGANIZATION, UPDATE)` del controller. El catálogo estático no
     * distingue CREATE ni DELETE sobre la organización —sus dos permisos son `ORGANIZATION.READ`
     * y `ORGANIZATION.UPDATE`—, y el catálogo de permisos de organización es precisamente
     * configuración suya, así que crear, editar y borrar entradas caen todas bajo `UPDATE`.
     */
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
