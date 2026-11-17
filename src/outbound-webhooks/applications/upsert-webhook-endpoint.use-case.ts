import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager, QueryFailedError } from 'typeorm';

import { IntegrationApiClient } from 'src/api-key/interfaces/integration-api-client.interface';

import { UpsertWebhookEndpointDto } from '../dto/upsert-webhook-endpoint.dto';
import { WebhookEndpointEntity } from '../entities/webhook-endpoint.entity';
import { WebhookSecretVersionEntity } from '../entities/webhook-secret-version.entity';
import { OUTBOUND_WEBHOOK_EVENT_TYPE_ENUM } from '../enums/outbound-webhook-event-type.enum';
import { WEBHOOK_ENDPOINT_STATUS_ENUM } from '../enums/webhook-endpoint-status.enum';
import { WEBHOOK_SUBJECT_TYPE_ENUM } from '../enums/webhook-subject-type.enum';
import { IntegrationUpsertWebhookEndpointResult } from '../interfaces/integration-webhook-endpoint-response';
import { WebhookEndpointUrlPolicy } from '../services/webhook-endpoint-url-policy.service';
import { WebhookSecretCipherService } from '../services/webhook-secret-cipher.service';
import {
  findActiveSecretVersion,
  findOrganizationWebhookEndpoint,
  normalizeWebhookEvents,
  toWebhookEndpointData,
} from './webhook-endpoint.shared';

/** `unique_violation` de Postgres. */
const UNIQUE_VIOLATION = '23505';

/**
 * Crea o actualiza el endpoint de webhooks de la organización de la API key.
 *
 * - Sin endpoint: lo crea `ACTIVE` con la versión 1 del secreto y devuelve el secreto, la única vez.
 * - Con endpoint: cambia URL y eventos y lo deja `ACTIVE` (reactiva uno desactivado). El secreto
 *   no cambia ni se devuelve; para cambiarlo está `RotateWebhookSecretUseCase`.
 */
@Injectable()
export class UpsertWebhookEndpointUseCase {
  constructor(
    private readonly dataSource: DataSource,
    private readonly urlPolicy: WebhookEndpointUrlPolicy,
    private readonly cipher: WebhookSecretCipherService,
  ) {}

  /**
   * Guarda la configuración.
   *
   * @param apiClient - Llave autenticada; de ella sale la organización.
   * @param dto - URL y eventos.
   * @returns `created` y la respuesta: con `secret` si se creó, sin él si se actualizó.
   *
   * @throws {WebhookUrlNotAllowedException} Si la URL no es un destino permitido.
   * @throws {WebhookSecretEncryptionUnavailableException} Si al crear falta la llave de cifrado.
   *
   * @example
   * ```ts
   * const { created, response } = await upsertWebhookEndpoint.execute(apiClient, {
   *   url: 'https://erp.cliente.com/webhooks/firmalo',
   *   events: ['document.signed'],
   * });
   * ```
   */
  async execute(
    apiClient: IntegrationApiClient,
    dto: UpsertWebhookEndpointDto,
  ): Promise<IntegrationUpsertWebhookEndpointResult> {
    const url = await this.urlPolicy.assertAllowed(dto.url);
    const events = normalizeWebhookEvents(dto.events);

    try {
      return await this.save(apiClient.organizationId, url, events);
    } catch (error) {
      // Dos peticiones crearon a la vez: la otra ganó el `UQ_webhook_endpoints_subject`. Ésta se
      // repite y, al encontrar el endpoint, lo actualiza.
      if (isUniqueViolation(error)) {
        return this.save(apiClient.organizationId, url, events);
      }
      throw error;
    }
  }

  private save(
    organizationId: string,
    url: string,
    events: OUTBOUND_WEBHOOK_EVENT_TYPE_ENUM[],
  ): Promise<IntegrationUpsertWebhookEndpointResult> {
    return this.dataSource.transaction(async (manager) => {
      const existing = await findOrganizationWebhookEndpoint(
        manager,
        organizationId,
        true,
      );
      return existing
        ? this.update(manager, existing, url, events)
        : this.create(manager, organizationId, url, events);
    });
  }

  private async update(
    manager: EntityManager,
    endpoint: WebhookEndpointEntity,
    url: string,
    events: OUTBOUND_WEBHOOK_EVENT_TYPE_ENUM[],
  ): Promise<IntegrationUpsertWebhookEndpointResult> {
    endpoint.url = url;
    endpoint.subscribedEventTypes = events;
    endpoint.status = WEBHOOK_ENDPOINT_STATUS_ENUM.ACTIVE;
    endpoint.disabledAt = null;
    const saved = await manager
      .getRepository(WebhookEndpointEntity)
      .save(endpoint);
    const active = await findActiveSecretVersion(manager, saved.id);

    return {
      created: false,
      response: {
        success: true,
        message: 'Endpoint de webhooks actualizado correctamente',
        data: toWebhookEndpointData(saved, active.version),
      },
    };
  }

  private async create(
    manager: EntityManager,
    organizationId: string,
    url: string,
    events: OUTBOUND_WEBHOOK_EVENT_TYPE_ENUM[],
  ): Promise<IntegrationUpsertWebhookEndpointResult> {
    const secret = this.cipher.generateSecret();
    const encryptedSecret = this.cipher.encrypt(secret);

    const endpoint = await manager.getRepository(WebhookEndpointEntity).save(
      manager.getRepository(WebhookEndpointEntity).create({
        subjectType: WEBHOOK_SUBJECT_TYPE_ENUM.ORGANIZATION,
        subjectId: organizationId,
        url,
        status: WEBHOOK_ENDPOINT_STATUS_ENUM.ACTIVE,
        subscribedEventTypes: events,
        disabledAt: null,
      }),
    );
    const version = await manager
      .getRepository(WebhookSecretVersionEntity)
      .save(
        manager.getRepository(WebhookSecretVersionEntity).create({
          endpointId: endpoint.id,
          version: 1,
          encryptedSecret,
          retiredAt: null,
        }),
      );

    return {
      created: true,
      response: {
        success: true,
        message: 'Endpoint de webhooks creado correctamente',
        data: { ...toWebhookEndpointData(endpoint, version.version), secret },
      },
    };
  }
}

function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof QueryFailedError &&
    (error.driverError as { code?: string } | undefined)?.code ===
      UNIQUE_VIOLATION
  );
}
