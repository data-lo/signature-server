import { Injectable } from '@nestjs/common';

import { IntegrationApiClient } from 'src/api-key/interfaces/integration-api-client.interface';

import { UpdateIntegrationSettingsDto } from '../dto/update-integration-settings.dto';
import {
  IntegrationSettingsResponse,
  toIntegrationSettingsResponse,
} from '../interfaces/integration-settings-response.interface';
import { IntegrationSettingsService } from '../services/integration-settings.service';

/** Activa o desactiva los webhooks de la integración de la organización de la API key. */
@Injectable()
export class UpdateIntegrationSettingsUseCase {
  constructor(
    private readonly integrationSettingsService: IntegrationSettingsService,
  ) {}

  /**
   * Fija `webhooksEnabled` de forma idempotente: crea la fila si no existe y repetir el mismo valor
   * no crea filas ni cambia nada. No toca las API keys.
   *
   * @param apiClient - Cliente autenticado; la organización sale sólo de aquí.
   * @param dto - Valor deseado, ya validado.
   * @returns `{ success: true, data: { webhooksEnabled } }` con el valor guardado.
   *
   * @throws {QueryFailedError} Si la organización de la llave ya no existe (FK); el guard lo
   *   impide antes en condiciones normales.
   *
   * @example
   * ```ts
   * await updateIntegrationSettings.execute(apiClient, { webhooksEnabled: true });
   * ```
   */
  async execute(
    apiClient: IntegrationApiClient,
    dto: UpdateIntegrationSettingsDto,
  ): Promise<IntegrationSettingsResponse> {
    const settings = await this.integrationSettingsService.setWebhooksEnabled(
      apiClient.organizationId,
      dto.webhooksEnabled,
    );

    return toIntegrationSettingsResponse(settings);
  }
}
