import { Injectable } from '@nestjs/common';

import { BaseResponse } from 'src/interfaces/api-response.dto';

import { AccountService } from '../account.service';
import { AccountData } from '../interfaces/response/account-response';

/**
 * `GET /api/v1/accounts/me`: las cuentas entre las que puede cambiar el usuario autenticado.
 *
 * Se sirve sólo desde Redis, sin volver a PostgreSQL si la key falta: el catálogo lo mantienen
 * al día las operaciones que lo alteran (crear organización, aceptar invitación, revocar
 * acceso), y responder un catálogo vacío es preferible a una consulta pesada en cada carga de
 * la aplicación.
 */
@Injectable()
export class GetMyAccountsUseCase {
  constructor(private readonly accountService: AccountService) {}

  async execute(userId: string): Promise<BaseResponse<AccountData[]>> {
    return this.accountService.getAccountsCatalog(userId);
  }
}
