import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { IntegrationApiClient } from 'src/api-key/interfaces/integration-api-client.interface';
import { BaseResponse } from 'src/interfaces/api-response.dto';

import { WebhookEndpointEntity } from '../entities/webhook-endpoint.entity';
import { WEBHOOK_ENDPOINT_STATUS_ENUM } from '../enums/webhook-endpoint-status.enum';
import { WebhookEndpointNotFoundException } from '../exceptions/outbound-webhook.exceptions';
import { IntegrationWebhookEndpointData } from '../interfaces/integration-webhook-endpoint-response';
import {
  findActiveSecretVersion,
  findOrganizationWebhookEndpoint,
  toWebhookEndpointData,
} from './webhook-endpoint.shared';

/**
 * Desactiva el endpoint de webhooks de la organización de la API key.
 *
 * Deja de registrar entregas nuevas; las ya registradas se siguen enviando con su snapshot. No
 * borra nada: `PUT` lo reactiva con el mismo secreto. Es idempotente.
 */
@Injectable()
export class DisableWebhookEndpointUseCase {
  constructor(private readonly dataSource: DataSource) {}

  /**
   * Pasa el endpoint a `DISABLED`.
   *
   * @param apiClient - Llave autenticada; de ella sale la organización.
   * @returns El endpoint desactivado.
   *
   * @throws {WebhookEndpointNotFoundException} Si la organización no configuró un endpoint.
   *
   * @example
   * ```ts
   * const { data } = await disableWebhookEndpoint.execute(apiClient);
   * data.status; // 'DISABLED'
   * ```
   */
  async execute(
    apiClient: IntegrationApiClient,
  ): Promise<BaseResponse<IntegrationWebhookEndpointData>> {
    return this.dataSource.transaction(async (manager) => {
      const endpoint = await findOrganizationWebhookEndpoint(
        manager,
        apiClient.organizationId,
        true,
      );
      if (!endpoint) throw new WebhookEndpointNotFoundException();

      let saved = endpoint;
      if (endpoint.status !== WEBHOOK_ENDPOINT_STATUS_ENUM.DISABLED) {
        endpoint.status = WEBHOOK_ENDPOINT_STATUS_ENUM.DISABLED;
        endpoint.disabledAt = new Date();
        saved = await manager
          .getRepository(WebhookEndpointEntity)
          .save(endpoint);
      }
      const active = await findActiveSecretVersion(manager, saved.id);

      return {
        success: true,
        message: 'Endpoint de webhooks desactivado correctamente',
        data: toWebhookEndpointData(saved, active.version),
      };
    });
  }
}
