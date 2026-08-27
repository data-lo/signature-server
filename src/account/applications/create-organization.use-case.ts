import { Injectable } from '@nestjs/common';

import { BaseResponse } from 'src/interfaces/api-response.dto';

import { AccountService } from '../account.service';
import { CreateOrganizationDto } from '../dto/create-organization.dto';
import { AccountData } from '../interfaces/response/account-response';

/**
 * `POST /api/v1/organizations`: crea una organización y deja a su creador dentro como
 * administrador.
 *
 * El alta va en una transacción (ver `saveOrganizationWithAdminAccount`); el refresco del
 * catálogo de Redis queda fuera de ella a propósito: es un cache y su fallo no debe deshacer una
 * organización que ya se creó bien.
 */
@Injectable()
export class CreateOrganizationUseCase {
  constructor(private readonly accountService: AccountService) {}

  async execute(
    userId: string,
    dto: CreateOrganizationDto,
  ): Promise<BaseResponse<AccountData>> {
    const currentUser = await this.accountService.findUserOrFail(userId);

    const fullAccount =
      await this.accountService.saveOrganizationWithAdminAccount(
        currentUser,
        dto,
      );

    await this.accountService.appendAccountToCatalog(userId, fullAccount);

    return {
      success: true,
      message: 'Organización creada correctamente',
      data: this.accountService.toCatalogEntry(fullAccount),
    };
  }
}
