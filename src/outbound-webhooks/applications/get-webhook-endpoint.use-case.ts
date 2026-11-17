import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { IntegrationApiClient } from 'src/api-key/interfaces/integration-api-client.interface';
import { BaseResponse } from 'src/interfaces/api-response.dto';

import { WebhookEndpointNotFoundException } from '../exceptions/outbound-webhook.exceptions';
import { IntegrationWebhookEndpointData } from '../interfaces/integration-webhook-endpoint-response';
import {
  findActiveSecretVersion,
  findOrganizationWebhookEndpoint,
  toWebhookEndpointData,
} from './webhook-endpoint.shared';

/** Consulta el endpoint de webhooks de la organización de la API key, sin revelar el secreto. */
@Injectable()
export class GetWebhookEndpointUseCase {
  constructor(private readonly dataSource: DataSource) {}

  /**
   * Devuelve la configuración del endpoint de la organización.
   *
   * @param apiClient - Llave autenticada; de ella sale la organización.
   * @returns URL, estado, eventos y versión del secreto activo. Nunca el secreto.
   *
   * @throws {WebhookEndpointNotFoundException} Si la organización no configuró un endpoint.
   *
   * @example
   * ```ts
   * const { data } = await getWebhookEndpoint.execute(apiClient);
   * ```
   */
  async execute(
    apiClient: IntegrationApiClient,
  ): Promise<BaseResponse<IntegrationWebhookEndpointData>> {
    const manager = this.dataSource.manager;
    const endpoint = await findOrganizationWebhookEndpoint(
      manager,
      apiClient.organizationId,
    );
    if (!endpoint) throw new WebhookEndpointNotFoundException();

    const active = await findActiveSecretVersion(manager, endpoint.id);
    return {
      success: true,
      message: 'Endpoint de webhooks obtenido correctamente',
      data: toWebhookEndpointData(endpoint, active.version),
    };
  }
}
