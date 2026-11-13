import { EntityManager, IsNull } from 'typeorm';

import { WebhookEndpointEntity } from '../entities/webhook-endpoint.entity';
import { WebhookSecretVersionEntity } from '../entities/webhook-secret-version.entity';
import { OUTBOUND_WEBHOOK_EVENT_TYPE_ENUM } from '../enums/outbound-webhook-event-type.enum';
import { WEBHOOK_SUBJECT_TYPE_ENUM } from '../enums/webhook-subject-type.enum';
import { WebhookEndpointNotFoundException } from '../exceptions/outbound-webhook.exceptions';
import { IntegrationWebhookEndpointData } from '../interfaces/integration-webhook-endpoint-response';

/** Orden del contrato; la respuesta y la base guardan los eventos así, sin importar cómo llegaron. */
const EVENT_ORDER = Object.values(OUTBOUND_WEBHOOK_EVENT_TYPE_ENUM);

/**
 * Los eventos sin repetir y en el orden del contrato.
 *
 * @param events - Eventos que pidió el cliente.
 * @returns Los mismos, ordenados y sin duplicados.
 *
 * @example
 * ```ts
 * normalizeWebhookEvents(['document.signed', 'document.collaborator_signed']);
 * // ['document.collaborator_signed', 'document.signed']
 * ```
 */
export function normalizeWebhookEvents(
  events: OUTBOUND_WEBHOOK_EVENT_TYPE_ENUM[],
): OUTBOUND_WEBHOOK_EVENT_TYPE_ENUM[] {
  return EVENT_ORDER.filter((event) => events.includes(event));
}

/**
 * Busca el endpoint de la organización, opcionalmente bloqueándolo para modificarlo.
 *
 * @param manager - Conexión o transacción.
 * @param organizationId - Organización de la API key.
 * @param lock - `true` toma `FOR UPDATE` sobre la fila (sólo dentro de una transacción).
 * @returns El endpoint, o `null` si la organización no tiene uno.
 *
 * @example
 * ```ts
 * const endpoint = await findOrganizationWebhookEndpoint(manager, apiClient.organizationId, true);
 * ```
 */
export function findOrganizationWebhookEndpoint(
  manager: EntityManager,
  organizationId: string,
  lock = false,
): Promise<WebhookEndpointEntity | null> {
  return manager.getRepository(WebhookEndpointEntity).findOne({
    where: {
      subjectType: WEBHOOK_SUBJECT_TYPE_ENUM.ORGANIZATION,
      subjectId: organizationId,
    },
    ...(lock ? { lock: { mode: 'pessimistic_write' as const } } : {}),
  });
}

/**
 * La versión activa (sin `retired_at`) del secreto de un endpoint.
 *
 * @param manager - Conexión o transacción.
 * @param endpointId - Endpoint.
 * @returns La versión activa.
 *
 * @throws {WebhookEndpointNotFoundException} Si el endpoint no tiene versión activa, lo que sólo
 *   pasaría con datos corruptos: todo endpoint nace con su versión 1.
 *
 * @example
 * ```ts
 * const active = await findActiveSecretVersion(manager, endpoint.id);
 * ```
 */
export async function findActiveSecretVersion(
  manager: EntityManager,
  endpointId: string,
): Promise<WebhookSecretVersionEntity> {
  const active = await manager
    .getRepository(WebhookSecretVersionEntity)
    .findOne({ where: { endpointId, retiredAt: IsNull() } });
  if (!active) throw new WebhookEndpointNotFoundException();
  return active;
}

/**
 * Lo que la API devuelve de un endpoint. Nunca incluye el secreto ni su versión cifrada.
 *
 * @param endpoint - Endpoint guardado.
 * @param secretVersion - Número de la versión activa del secreto.
 * @returns Los datos públicos del endpoint.
 *
 * @example
 * ```ts
 * toWebhookEndpointData(endpoint, 1);
 * ```
 */
export function toWebhookEndpointData(
  endpoint: WebhookEndpointEntity,
  secretVersion: number,
): IntegrationWebhookEndpointData {
  return {
    id: endpoint.id,
    url: endpoint.url,
    status: endpoint.status,
    events: normalizeWebhookEvents(endpoint.subscribedEventTypes),
    secretVersion,
    createdAt: endpoint.createdAt.toISOString(),
    updatedAt: endpoint.updatedAt.toISOString(),
    disabledAt: endpoint.disabledAt?.toISOString() ?? null,
  };
}
