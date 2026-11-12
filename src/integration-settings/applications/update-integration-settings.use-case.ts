import { Injectable } from '@nestjs/common';

import { BaseResponse } from 'src/interfaces/api-response.dto';

import { UpdateIntegrationSettingsDto } from '../dto/update-integration-settings.dto';
import { IntegrationSettingsOrganizationNotFoundException } from '../exceptions/integration-settings.exceptions';
import {
  IntegrationSettingsData,
  toIntegrationSettingsData,
} from '../interfaces/integration-settings-response.interface';
import { IntegrationSettingsService } from '../services/integration-settings.service';

/** Activa o desactiva la integración de una organización. */
@Injectable()
export class UpdateIntegrationSettingsUseCase {
  constructor(
    private readonly integrationSettingsService: IntegrationSettingsService,
  ) {}

  /**
   * Fija el estado de la integración de forma idempotente: repetir el mismo estado no crea filas
   * ni cambia `updatedAt`. No toca las API keys de la organización; desactivar sólo hace que
   * `OrganizationApiKeyGuard` rechace las peticiones nuevas.
   *
   * @param organizationId - `:organizationId` de la ruta, ya autorizado por `PermissionsGuard`.
   * @param dto - Estado deseado.
   * @returns La configuración resultante.
   *
   * @throws {IntegrationSettingsOrganizationNotFoundException} (404) Si la organización no existe
   *   o está desactivada.
   *
   * @example
   * ```ts
   * await updateIntegrationSettings.execute('org-1', { status: INTEGRATION_STATUS_ENUM.DISABLED });
   * ```
   */
  async execute(
    organizationId: string,
    dto: UpdateIntegrationSettingsDto,
  ): Promise<BaseResponse<IntegrationSettingsData>> {
    if (
      !(await this.integrationSettingsService.isActiveOrganization(
        organizationId,
      ))
    ) {
      throw new IntegrationSettingsOrganizationNotFoundException();
    }

    const settings = await this.integrationSettingsService.setStatus(
      organizationId,
      dto.status,
    );

    return {
      success: true,
      message: 'Configuración de integración actualizada correctamente',
      data: toIntegrationSettingsData(organizationId, settings),
    };
  }
}
