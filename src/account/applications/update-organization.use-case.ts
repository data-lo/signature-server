import { Injectable } from '@nestjs/common';

import { BaseResponse } from 'src/interfaces/api-response.dto';

import { AccountService } from '../account.service';
import { UpdateOrganizationDto } from '../dto/update-organization.dto';
import { OrganizationProfileData } from '../interfaces/response/organization-response';

/**
 * `PATCH /api/v1/organizations/:organizationId`: guarda "Información de la organización".
 *
 * Es la escritura hermana de `GET /organizations/:organizationId` y responde con el mismo perfil,
 * para que la pantalla refleje lo guardado sin pedirlo otra vez. El permiso y el aislamiento
 * multi-tenant los resuelve `PermissionsGuard` con el `organizationId` de la ruta: sólo un
 * miembro activo de ESA organización con `ORGANIZATION.UPDATE` llega hasta aquí.
 *
 * Si cambia alguno de los dos nombres se refresca el catálogo cacheado de todos los miembros
 * activos, porque el selector de cuentas de cada uno rotula la organización con ellos. RFC,
 * teléfono, domicilio y dominio no aparecen en el catálogo, así que no lo tocan.
 */
@Injectable()
export class UpdateOrganizationUseCase {
  constructor(private readonly accountService: AccountService) {}

  /**
   * Escribe los campos que vinieron y devuelve el perfil como quedó.
   *
   * @param organizationId - Organización a editar, tomada de la ruta.
   * @param dto - Campos del perfil; los ausentes no se tocan y los opcionales en `null` se borran.
   * @returns El perfil actualizado, con la misma forma que la lectura.
   *
   * @throws {ForbiddenException} Si quien edita no es miembro activo de esa organización o su rol
   *   no tiene `ORGANIZATION.UPDATE` — lo lanza `PermissionsGuard`, antes de llegar aquí.
   * @throws {BadRequestException} Si algún campo no pasa la validación del DTO — lo lanza el
   *   `ValidationPipe`, antes de llegar aquí.
   * @throws {NotFoundException} Si no existe ninguna organización con ese id.
   *
   * @example
   * ```ts
   * const response = await updateOrganization.execute('org-1', {
   *   displayName: 'Acme',
   *   taxId: 'ACM010101AAA',
   * });
   * response.data.displayName; // 'Acme'
   * ```
   */
  async execute(
    organizationId: string,
    dto: UpdateOrganizationDto,
  ): Promise<BaseResponse<OrganizationProfileData>> {
    const organization = await this.accountService.updateOrganizationProfile(
      organizationId,
      dto,
    );

    if (dto.displayName !== undefined || dto.name !== undefined) {
      await this.accountService.refreshCatalogForOrganizationMembers(
        organizationId,
      );
    }

    return {
      success: true,
      message: 'Organización actualizada correctamente',
      data: this.accountService.toOrganizationProfile(organization),
    };
  }
}
