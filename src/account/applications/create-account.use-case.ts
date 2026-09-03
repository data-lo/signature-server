import { Injectable } from '@nestjs/common';

import { BaseResponse } from 'src/interfaces/api-response.dto';
import { RolesService } from 'src/roles/roles.service';
import { SYSTEM_ROLE_NAME_ENUM } from 'src/roles/enums/system-role-name.enum';

import { AccountService } from '../account.service';
import { CreateAccountDto } from '../dto/create-account.dto';
import { ACCOUNT_TYPE_ENUM } from '../enums/account-type.enum';
import { AccountData } from '../interfaces/response/account-response';

/**
 * Crea una cuenta genérica (`POST /account`).
 *
 * Sin consumidor real en el frontend, que usa `POST /api/v1/organizations` y el registro: se
 * mantiene funcional contra el modelo fusionado, sin pulir más allá de eso.
 *
 * A diferencia de `CreateOrganizationUseCase`, no envuelve la organización y la cuenta en una
 * transacción: es el comportamiento que ya tenía el endpoint.
 */
@Injectable()
export class CreateAccountUseCase {
  constructor(
    private readonly accountService: AccountService,
    private readonly rolesService: RolesService,
  ) {}

  async execute(
    currentUserId: string,
    createAccountDto: CreateAccountDto,
  ): Promise<BaseResponse<AccountData>> {
    const currentUser = await this.accountService.findUserOrFail(currentUserId);

    const adminRole = await this.rolesService.findSystemRoleByName(
      SYSTEM_ROLE_NAME_ENUM.ADMIN,
    );

    let organizationId: string | null = null;
    if (createAccountDto.type === ACCOUNT_TYPE_ENUM.ORGANIZATION) {
      const organization = await this.accountService.saveOrganization({
        name: createAccountDto.organizationName ?? createAccountDto.name,
        address: createAccountDto.address,
        rfc: createAccountDto.rfc,
        domainAllowed: createAccountDto.domainAllowed,
        phoneNumber: createAccountDto.phoneNumber,
        indexDocuments: createAccountDto.indexDocuments,
      });
      organizationId = organization.id;
    }

    const account = await this.accountService.saveAccount({
      userId: currentUserId,
      accountType: createAccountDto.type,
      organizationId,
      roleId: adminRole.id,
      user: currentUser,
    });

    /**
     * Se relee con la relación de organización cargada: `toCatalogEntry` publica el nombre de
     * la organización, y la fila que devuelve el save no la trae.
     */
    const fullAccount = await this.accountService.findByIdOrFail(account.id);

    return {
      success: true,
      message: 'Cuenta creada correctamente',
      data: this.accountService.toCatalogEntry(fullAccount),
    };
  }
}
