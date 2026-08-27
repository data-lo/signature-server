import { Injectable } from '@nestjs/common';

import { BaseResponse } from 'src/interfaces/api-response.dto';
import { ACTION_KEY_ENUM } from 'src/roles/enums/action-key.enum';

import { AccountMemberService } from '../account-member.service';
import { AccountService } from '../account.service';

/**
 * `DELETE /account-member/:id` y `DELETE /api/v1/organizations/members/:accountId`: saca a un
 * miembro de la organización.
 *
 * La baja es lógica: la fila queda referenciada desde los documentos que ese miembro creó o
 * firmó, y borrarla dejaría esas firmas sin dueño.
 *
 * Después se quita la organización del catálogo cacheado del afectado, para que el selector de
 * cuentas del frontend deje de ofrecerle un contexto al que ya no puede entrar.
 */
@Injectable()
export class RevokeAccountAccessUseCase {
  constructor(
    private readonly accountMemberService: AccountMemberService,
    private readonly accountService: AccountService,
  ) {}

  async execute(callerId: string, id: string): Promise<BaseResponse> {
    const membership =
      await this.accountMemberService.findActiveMembershipOrFail(id);

    await this.accountMemberService.assertHasOrganizationPermission(
      callerId,
      membership.organizationId,
      ACTION_KEY_ENUM.DELETE,
    );

    await this.accountMemberService.assertNotLastAdmin(
      membership.organizationId,
      membership,
    );

    await this.accountMemberService.markMembershipRemoved(id);

    await this.accountService.removeAccountFromCatalog(
      membership.userId,
      membership.id,
    );

    return {
      success: true,
      message: 'Acceso revocado correctamente',
    };
  }
}
