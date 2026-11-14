import { Injectable } from '@nestjs/common';

import { IntegrationApiClient } from 'src/api-key/interfaces/integration-api-client.interface';

import { UpdateIntegrationApiSettingsDto } from '../dto/update-integration-api-settings.dto';
import {
  IntegrationApiSettingsResponse,
  toIntegrationApiSettingsResponse,
} from '../interfaces/integration-api-settings-response.interface';
import { IntegrationSettingsService } from '../services/integration-settings.service';

/** Activa o desactiva, desde la API de integración, los webhooks de la organización de la llave. */
@Injectable()
export class UpdateIntegrationApiSettingsUseCase {
  constructor(
    private readonly integrationSettingsService: IntegrationSettingsService,
  ) {}

  /**
   * Fija `webhooksEnabled` de forma idempotente: crea la fila si no existe y repetir el mismo valor
   * no cambia nada. No toca el `status` administrativo ni las API keys.
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
   * await updateIntegrationApiSettings.execute(apiClient, { webhooksEnabled: true });
   * ```
   */
  async execute(
    apiClient: IntegrationApiClient,
    dto: UpdateIntegrationApiSettingsDto,
  ): Promise<IntegrationApiSettingsResponse> {
    const settings = await this.integrationSettingsService.setWebhooksEnabled(
      apiClient.organizationId,
      dto.webhooksEnabled,
    );

    return toIntegrationApiSettingsResponse(settings);
  }
}
