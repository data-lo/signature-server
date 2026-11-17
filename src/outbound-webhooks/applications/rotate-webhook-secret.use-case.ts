import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { IntegrationApiClient } from 'src/api-key/interfaces/integration-api-client.interface';
import { BaseResponse } from 'src/interfaces/api-response.dto';

import { WebhookSecretVersionEntity } from '../entities/webhook-secret-version.entity';
import { WebhookEndpointNotFoundException } from '../exceptions/outbound-webhook.exceptions';
import { IntegrationWebhookEndpointWithSecretData } from '../interfaces/integration-webhook-endpoint-response';
import { WebhookSecretCipherService } from '../services/webhook-secret-cipher.service';
import {
  findActiveSecretVersion,
  findOrganizationWebhookEndpoint,
  toWebhookEndpointData,
} from './webhook-endpoint.shared';

/**
 * Rota el secreto del endpoint de webhooks de la organización de la API key.
 *
 * En una transacción, con la fila del endpoint bloqueada, retira la versión activa y crea la
 * siguiente. Las entregas nuevas se firman con la nueva; las ya registradas conservan la suya y se
 * siguen firmando con ella hasta terminar, así que el receptor debe aceptar ambos secretos durante
 * esa ventana (24 h como máximo).
 */
@Injectable()
export class RotateWebhookSecretUseCase {
  constructor(
    private readonly dataSource: DataSource,
    private readonly cipher: WebhookSecretCipherService,
  ) {}

  /**
   * Genera la siguiente versión del secreto y la devuelve, la única vez.
   *
   * @param apiClient - Llave autenticada; de ella sale la organización.
   * @returns El endpoint con la versión nueva y su `secret`.
   *
   * @throws {WebhookEndpointNotFoundException} Si la organización no configuró un endpoint.
   * @throws {WebhookSecretEncryptionUnavailableException} Si falta la llave de cifrado.
   *
   * @example
   * ```ts
   * const { data } = await rotateWebhookSecret.execute(apiClient);
   * data.secret; // 'whsec_…'
   * ```
   */
  async execute(
    apiClient: IntegrationApiClient,
  ): Promise<BaseResponse<IntegrationWebhookEndpointWithSecretData>> {
    const secret = this.cipher.generateSecret();
    const encryptedSecret = this.cipher.encrypt(secret);

    return this.dataSource.transaction(async (manager) => {
      const endpoint = await findOrganizationWebhookEndpoint(
        manager,
        apiClient.organizationId,
        true,
      );
      if (!endpoint) throw new WebhookEndpointNotFoundException();

      const versions = manager.getRepository(WebhookSecretVersionEntity);
      const active = await findActiveSecretVersion(manager, endpoint.id);
      // Primero se retira: `UQ_webhook_secret_versions_active` admite una sola versión activa.
      active.retiredAt = new Date();
      await versions.save(active);

      const next = await versions.save(
        versions.create({
          endpointId: endpoint.id,
          version: active.version + 1,
          encryptedSecret,
          retiredAt: null,
        }),
      );

      return {
        success: true,
        message: 'Secreto del webhook rotado correctamente',
        data: { ...toWebhookEndpointData(endpoint, next.version), secret },
      };
    });
  }
}
