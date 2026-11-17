import { Injectable } from '@nestjs/common';

import { IntegrationApiClient } from 'src/api-key/interfaces/integration-api-client.interface';

import {
  IntegrationApiSettingsResponse,
  toIntegrationApiSettingsResponse,
} from '../interfaces/integration-api-settings-response.interface';
import { IntegrationSettingsService } from '../services/integration-settings.service';

/** Consulta, desde la API de integración, la configuración de la organización de la API key. */
@Injectable()
export class GetIntegrationApiSettingsUseCase {
  constructor(
    private readonly integrationSettingsService: IntegrationSettingsService,
  ) {}

  /**
   * Devuelve las opciones configurables de la organización, o los valores por defecto si no hay
   * fila. No escribe.
   *
   * @param apiClient - Cliente autenticado; la organización sale sólo de aquí.
   * @returns `{ success: true, data: { webhooksEnabled } }`.
   *
   * @example
   * ```ts
   * const { data } = await getIntegrationApiSettings.execute(apiClient); // data.webhooksEnabled === false
   * ```
   */
  async execute(
    apiClient: IntegrationApiClient,
  ): Promise<IntegrationApiSettingsResponse> {
    const settings = await this.integrationSettingsService.findByOrganization(
      apiClient.organizationId,
    );

    return toIntegrationApiSettingsResponse(settings);
  }
}
