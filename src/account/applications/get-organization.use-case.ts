import { Injectable } from '@nestjs/common';

import { BaseResponse } from 'src/interfaces/api-response.dto';

import { AccountService } from '../account.service';
import { OrganizationProfileData } from '../interfaces/response/organization-response';

/**
 * `GET /api/v1/organizations/:organizationId`: el perfil de una organización, para la pantalla
 * "Información de la organización".
 *
 * Cubre un hueco del contrato: estos campos —RFC, teléfono, domicilio, dominio permitido— se
 * podían ESCRIBIR desde siempre con `PATCH /account/:id`, pero ninguna lectura los devolvía. El
 * catálogo de cuentas (`GET /accounts/me`) publica sólo la razón social y el nombre de
 * visualización, que es lo que rotula el selector.
 *
 * El aislamiento multi-tenant no depende del `organizationId` de la URL sino de
 * `PermissionsGuard`: ese identificador es justo el que el guard usa para resolver la cuenta
 * activa, así que pedir el perfil de otra organización responde 403 antes de llegar aquí.
 */
@Injectable()
export class GetOrganizationUseCase {
  constructor(private readonly accountService: AccountService) {}

  /**
   * Devuelve el perfil de la organización indicada.
   *
   * @param organizationId - Organización cuyo perfil se pide.
   * @returns El perfil, sin los campos que la pantalla no muestra.
   *
   * @throws {ForbiddenException} Si quien pregunta no es miembro activo de esa organización o su
   *   rol no tiene `ORGANIZATION.READ` — lo lanza `PermissionsGuard`, antes de llegar aquí.
   * @throws {NotFoundException} Si no existe ninguna organización con ese id.
   *
   * @example
   * ```ts
   * const response = await getOrganization.execute('org-1');
   * response.data.rfc; // 'ACM010101AAA'
   * ```
   */
  async execute(
    organizationId: string,
  ): Promise<BaseResponse<OrganizationProfileData>> {
    const organization =
      await this.accountService.findOrganizationByIdOrFail(organizationId);

    return {
      success: true,
      message: 'Organización obtenida correctamente',
      data: {
        id: organization.id,
        name: organization.name,
        displayName: organization.displayName,
        rfc: organization.rfc,
        phoneNumber: organization.phoneNumber,
        address: organization.address,
        domainAllowed: organization.domainAllowed,
        isActive: organization.isActive,
      },
    };
  }
}
