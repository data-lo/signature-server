import { Injectable } from '@nestjs/common';

import { BaseResponse } from 'src/interfaces/api-response.dto';
import { ACTION_KEY_ENUM } from 'src/roles/enums/action-key.enum';

import { AccountMemberService } from '../account-member.service';
import { AccountEntity } from '../entities/account.entity';

/**
 * `GET /account-member/:id`: una membresía concreta.
 *
 * La organización se deduce de la propia membresía y sólo entonces se comprueba que el llamador
 * la administre: la ruta no la trae, y aceptarla como parámetro dejaría que el administrador de
 * una organización leyera membresías de otra.
 */
@Injectable()
export class GetAccountMemberUseCase {
  constructor(private readonly accountMemberService: AccountMemberService) {}

  async execute(
    callerId: string,
    id: string,
  ): Promise<BaseResponse<AccountEntity>> {
    const member = await this.accountMemberService.findMembershipOrFail(id);

    await this.accountMemberService.assertHasOrganizationPermission(
      callerId,
      member.organizationId,
      ACTION_KEY_ENUM.READ,
    );

    return {
      success: true,
      message: 'Miembro obtenido correctamente',
      data: member,
    };
  }
}
