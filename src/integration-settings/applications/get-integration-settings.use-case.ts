import { Injectable } from '@nestjs/common';

import { IntegrationApiClient } from 'src/api-key/interfaces/integration-api-client.interface';

import {
  IntegrationSettingsResponse,
  toIntegrationSettingsResponse,
} from '../interfaces/integration-settings-response.interface';
import { IntegrationSettingsService } from '../services/integration-settings.service';

/** Consulta la configuración de integración de la organización de la API key. */
@Injectable()
export class GetIntegrationSettingsUseCase {
  constructor(
    private readonly integrationSettingsService: IntegrationSettingsService,
  ) {}

  /**
   * Devuelve la configuración de la organización, o los valores por defecto si nunca se guardó.
   * No escribe.
   *
   * @param apiClient - Cliente autenticado; la organización sale sólo de aquí.
   * @returns `{ success: true, data: { webhooksEnabled } }`.
   *
   * @example
   * ```ts
   * const { data } = await getIntegrationSettings.execute(apiClient); // data.webhooksEnabled === false
   * ```
   */
  async execute(
    apiClient: IntegrationApiClient,
  ): Promise<IntegrationSettingsResponse> {
    const settings = await this.integrationSettingsService.findByOrganization(
      apiClient.organizationId,
    );

    return toIntegrationSettingsResponse(settings);
  }
}
