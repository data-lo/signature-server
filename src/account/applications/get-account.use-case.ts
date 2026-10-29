import { Injectable } from '@nestjs/common';

import { BaseResponse } from 'src/interfaces/api-response.dto';
import { ACTION_KEY_ENUM } from 'src/roles/enums/action-key.enum';

import { AccountService } from '../account.service';
import { AccountData } from '../interfaces/response/account-response';

/**
 * `GET /account/:id`: una cuenta propia del llamador.
 *
 * El `id` es siempre una fila de `accounts` del propio llamador —mismo criterio que
 * `X-Account-Id` en el resto de la API—, nunca la de otro usuario: la comprobación de permisos
 * busca la cuenta filtrando por `userId`, así que pedir la de otro da 403 y no revela nada de
 * ella.
 */
@Injectable()
export class GetAccountUseCase {
  constructor(private readonly accountService: AccountService) {}

  async execute(
    callerId: string,
    id: string,
  ): Promise<BaseResponse<AccountData>> {
    const account = await this.accountService.assertHasOrganizationPermission(
      callerId,
      id,
      ACTION_KEY_ENUM.READ,
    );

    return {
      success: true,
      message: 'Cuenta obtenida correctamente',
      data: this.accountService.toCatalogEntry(account),
    };
  }
}
