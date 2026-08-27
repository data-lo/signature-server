import { ConflictException, Injectable } from '@nestjs/common';

import { BaseResponse } from 'src/interfaces/api-response.dto';
import { ACTION_KEY_ENUM } from 'src/roles/enums/action-key.enum';
import { RolesService } from 'src/roles/roles.service';

import { AccountMemberService } from '../account-member.service';
import { CreateAccountMemberDto } from '../dto/create-account-member.dto';
import { AccountEntity } from '../entities/account.entity';

/**
 * `POST /account-member`: da acceso directo a una organización a alguien que ya tiene cuenta,
 * sin pasar por el flujo de invitación por correo.
 *
 * Es el camino administrativo: quien lo usa ya sabe el `userId` del invitado, así que no hay
 * token que canjear ni correo que esperar.
 */
@Injectable()
export class GrantAccountAccessUseCase {
  constructor(
    private readonly accountMemberService: AccountMemberService,
    private readonly rolesService: RolesService,
  ) {}

  async execute(
    callerId: string,
    dto: CreateAccountMemberDto,
  ): Promise<BaseResponse<AccountEntity>> {
    await this.accountMemberService.assertHasOrganizationPermission(
      callerId,
      dto.organizationId,
      ACTION_KEY_ENUM.CREATE,
    );

    await this.rolesService.findByIdOrFail(dto.roleId);

    /**
     * La membresía existente se busca sin filtrar por `isActive`: quien fue dado de baja
     * conserva su fila, y crear otra dejaría dos membresías de la misma persona en la misma
     * organización, con roles que podrían contradecirse.
     */
    const existingMembership =
      await this.accountMemberService.findExistingMembership(
        dto.organizationId,
        dto.userId,
      );
    if (existingMembership) {
      throw new ConflictException(
        'El usuario ya tiene acceso a esta organización',
      );
    }

    const invitedUser = await this.accountMemberService.findUserOrFail(
      dto.userId,
    );

    return {
      success: true,
      message: 'Acceso otorgado correctamente',
      data: await this.accountMemberService.saveMembership(dto, invitedUser),
    };
  }
}
