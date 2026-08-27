import { Injectable } from '@nestjs/common';

import { BaseResponse } from 'src/interfaces/api-response.dto';
import { ACTION_KEY_ENUM } from 'src/roles/enums/action-key.enum';

import { AccountMemberService } from '../account-member.service';
import { OrganizationMemberData } from '../interfaces/response/account-member-response';

/**
 * `GET /api/v1/organizations/:organizationId/members`: la tabla de gestión de miembros (ver
 * historia [STORY] Gestión de Miembros: Listado, Edición de Roles y Eliminación en
 * Organización).
 *
 * Publica sólo lo que esa pantalla muestra —correo, RFC, rol y fecha de ingreso— en vez de la
 * entidad completa, que traería la contraseña sincronizada de la membresía.
 */
@Injectable()
export class GetOrganizationMemberListUseCase {
  constructor(private readonly accountMemberService: AccountMemberService) {}

  async execute(
    callerId: string,
    organizationId: string,
  ): Promise<BaseResponse<OrganizationMemberData[]>> {
    await this.accountMemberService.assertHasOrganizationPermission(
      callerId,
      organizationId,
      ACTION_KEY_ENUM.READ,
    );

    return {
      success: true,
      message: 'Miembros obtenidos correctamente',
      data: await this.accountMemberService.listDetailedByOrganization(
        organizationId,
      ),
    };
  }
}
