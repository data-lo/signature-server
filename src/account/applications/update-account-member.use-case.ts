import { Injectable } from '@nestjs/common';

import { BaseResponse } from 'src/interfaces/api-response.dto';
import { ACTION_KEY_ENUM } from 'src/roles/enums/action-key.enum';
import { RolesService } from 'src/roles/roles.service';

import { AccountMemberService } from '../account-member.service';
import { UpdateAccountMemberDto } from '../dto/update-account-member.dto';
import { AccountEntity } from '../entities/account.entity';

/**
 * `PATCH /account-member/:id` y `PATCH /api/v1/organizations/members/:accountId/role`: cambia
 * el rol, el puesto o el estado de una membresía.
 *
 * Antes de cualquier escritura se comprueba que la organización no quede sin administradores.
 * Esa comprobación sólo hace falta cuando el cambio puede quitar uno: cambiar el puesto de
 * alguien, o reactivarlo, nunca reduce el número de administradores activos.
 */
@Injectable()
export class UpdateAccountMemberUseCase {
  constructor(
    private readonly accountMemberService: AccountMemberService,
    private readonly rolesService: RolesService,
  ) {}

  async execute(
    callerId: string,
    id: string,
    dto: UpdateAccountMemberDto,
  ): Promise<BaseResponse<AccountEntity>> {
    const member = await this.accountMemberService.findMembershipOrFail(id);

    await this.accountMemberService.assertHasOrganizationPermission(
      callerId,
      member.organizationId,
      ACTION_KEY_ENUM.UPDATE,
    );

    const changesRole =
      dto.roleId !== undefined && dto.roleId !== member.roleId;
    const deactivates = dto.isActive === false;

    if (changesRole || deactivates) {
      await this.accountMemberService.assertNotLastAdmin(
        member.organizationId,
        member,
      );
    }

    if (dto.roleId) {
      await this.rolesService.findByIdOrFail(dto.roleId);
    }

    await this.accountMemberService.applyMembershipUpdate(id, dto);

    return {
      success: true,
      message: 'Membresía actualizada correctamente',
      data: await this.accountMemberService.findByIdOrFail(id),
    };
  }
}
