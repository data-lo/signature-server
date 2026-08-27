import { Injectable } from '@nestjs/common';

import { BaseResponse } from 'src/interfaces/api-response.dto';
import { ACTION_KEY_ENUM } from 'src/roles/enums/action-key.enum';

import { AccountService } from '../account.service';
import { UpdateAccountDto } from '../dto/update-account.dto';
import { ACCOUNT_TYPE_ENUM } from '../enums/account-type.enum';
import { AccountData } from '../interfaces/response/account-response';

/**
 * `PATCH /account/:id`: edita el perfil de la organización detrás de una cuenta.
 *
 * Lo que se escribe vive en `organizations`, no en `accounts`: la cuenta es la membresía y no
 * tiene nombre ni domicilio propios. Por eso una cuenta personal no cambia nada aunque el DTO
 * traiga campos de organización.
 *
 * Al final se refresca el catálogo cacheado de **todos** los miembros activos, no sólo el de
 * quien editó: el nombre de la organización aparece en el selector de cuentas de cada uno, y si
 * sólo se refrescara el del editor los demás seguirían viendo el nombre viejo hasta que su key
 * de Redis se reconstruyera por otro motivo.
 */
@Injectable()
export class UpdateAccountUseCase {
  constructor(private readonly accountService: AccountService) {}

  async execute(
    callerId: string,
    id: string,
    updateAccountDto: UpdateAccountDto,
  ): Promise<BaseResponse<AccountData>> {
    const account = await this.accountService.assertHasOrganizationPermission(
      callerId,
      id,
      ACTION_KEY_ENUM.UPDATE,
    );

    const hasOrganizationDetailChanges =
      updateAccountDto.organizationName !== undefined ||
      updateAccountDto.address !== undefined ||
      updateAccountDto.rfc !== undefined ||
      updateAccountDto.domainAllowed !== undefined ||
      updateAccountDto.phoneNumber !== undefined ||
      updateAccountDto.indexDocuments !== undefined;

    if (
      account.accountType === ACCOUNT_TYPE_ENUM.ORGANIZATION &&
      account.organizationId &&
      hasOrganizationDetailChanges
    ) {
      await this.accountService.updateOrganizationDetails(
        account.organizationId,
        updateAccountDto,
      );
    }

    const updatedAccount = await this.accountService.findByIdOrFail(id);

    if (hasOrganizationDetailChanges && updatedAccount.organizationId) {
      await this.accountService.refreshCatalogForOrganizationMembers(
        updatedAccount.organizationId,
      );
    }

    return {
      success: true,
      message: 'Cuenta actualizada correctamente',
      data: this.accountService.toCatalogEntry(updatedAccount),
    };
  }
}
