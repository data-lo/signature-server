import { Injectable } from '@nestjs/common';

import { BaseResponse } from 'src/interfaces/api-response.dto';
import { ACTION_KEY_ENUM } from 'src/roles/enums/action-key.enum';

import { AccountMemberService } from '../account-member.service';
import { AccountEntity } from '../entities/account.entity';

/**
 * `GET /account-member?organizationId=...`: miembros activos de una organización, como filas
 * de `accounts`.
 *
 * Devuelve la entidad completa; la vista de gestión de miembros usa
 * `GetOrganizationMemberListUseCase`, que publica un shape más delgado y con el RFC resuelto.
 */
@Injectable()
export class GetOrganizationMembersUseCase {
  constructor(private readonly accountMemberService: AccountMemberService) {}

  async execute(
    callerId: string,
    organizationId: string,
  ): Promise<BaseResponse<AccountEntity[]>> {
    await this.accountMemberService.assertHasOrganizationPermission(
      callerId,
      organizationId,
      ACTION_KEY_ENUM.READ,
    );

    return {
      success: true,
      message: 'Miembros obtenidos correctamente',
      data: await this.accountMemberService.listActiveByOrganization(
        organizationId,
      ),
    };
  }
}
