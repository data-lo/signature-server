import { Injectable } from '@nestjs/common';

import { BaseResponse } from 'src/interfaces/api-response.dto';

import { AccountService } from '../account.service';
import { AccountEntity } from '../entities/account.entity';

/**
 * `GET /account`: listado administrativo de todas las cuentas, sin filtro por tenant.
 */
@Injectable()
export class ListAccountsUseCase {
  constructor(private readonly accountService: AccountService) {}

  async execute(): Promise<BaseResponse<AccountEntity[]>> {
    return {
      success: true,
      message: 'Cuentas obtenidas correctamente',
      data: await this.accountService.listAll(),
    };
  }
}
