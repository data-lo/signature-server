import { Injectable } from '@nestjs/common';

import { BaseResponse } from 'src/interfaces/api-response.dto';

import { IntegrationSettingsOrganizationNotFoundException } from '../exceptions/integration-settings.exceptions';
import {
  IntegrationSettingsData,
  toIntegrationSettingsData,
} from '../interfaces/integration-settings-response.interface';
import { IntegrationSettingsService } from '../services/integration-settings.service';

/** Consulta la configuración de integración de una organización. */
@Injectable()
export class GetIntegrationSettingsUseCase {
  constructor(
    private readonly integrationSettingsService: IntegrationSettingsService,
  ) {}

  /**
   * Devuelve el estado de la integración de la organización de la ruta, sin datos de API keys.
   * No escribe: si la organización nunca tuvo configuración responde `ACTIVE` sin crearla.
   *
   * @param organizationId - `:organizationId` de la ruta, ya autorizado por `PermissionsGuard`.
   * @returns La configuración.
   *
   * @throws {IntegrationSettingsOrganizationNotFoundException} (404) Si la organización no existe
   *   o está desactivada.
   *
   * @example
   * ```ts
   * const { data } = await getIntegrationSettings.execute('org-1'); // data.status === 'ACTIVE'
   * ```
   */
  async execute(
    organizationId: string,
  ): Promise<BaseResponse<IntegrationSettingsData>> {
    if (
      !(await this.integrationSettingsService.isActiveOrganization(
        organizationId,
      ))
    ) {
      throw new IntegrationSettingsOrganizationNotFoundException();
    }

    const settings =
      await this.integrationSettingsService.findByOrganization(organizationId);

    return {
      success: true,
      message: 'Configuración de integración obtenida correctamente',
      data: toIntegrationSettingsData(organizationId, settings),
    };
  }
}
