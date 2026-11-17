import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { ApiKeyModule } from 'src/api-key/api-key.module';

import { DisableWebhookEndpointUseCase } from './applications/disable-webhook-endpoint.use-case';
import { GetWebhookEndpointUseCase } from './applications/get-webhook-endpoint.use-case';
import { RotateWebhookSecretUseCase } from './applications/rotate-webhook-secret.use-case';
import { UpsertWebhookEndpointUseCase } from './applications/upsert-webhook-endpoint.use-case';
import { IntegrationWebhookEndpointController } from './controllers/integration-webhook-endpoint.controller';

import { WebhookDeliveryAttemptEntity } from './entities/webhook-delivery-attempt.entity';
import { WebhookDeliveryEntity } from './entities/webhook-delivery.entity';
import { WebhookEndpointEntity } from './entities/webhook-endpoint.entity';
import { WebhookSecretVersionEntity } from './entities/webhook-secret-version.entity';
import { WebhookEndpointUrlPolicy } from './services/webhook-endpoint-url-policy.service';
import { WebhookSecretCipherService } from './services/webhook-secret-cipher.service';

/**
 * Webhooks salientes: notifica a los sistemas de los clientes los eventos de firma de sus
 * documentos. Distinto de `WebhooksModule`, que recibe los webhooks entrantes de Stripe, Didit y el
 * indexador.
 *
 * Hoy registra el modelo de datos y la configuración del endpoint desde la API de integración
 * (`/integration/webhooks/endpoint`, con `X-API-Key`). El registro y el envío de entregas (worker,
 * firma, reintentos) están descritos en `README.md` y llegan en las siguientes tareas.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      WebhookEndpointEntity,
      WebhookSecretVersionEntity,
      WebhookDeliveryEntity,
      WebhookDeliveryAttemptEntity,
    ]),
    // `OrganizationApiKeyGuard` y `ApiKeyPermissionGuard` del controlador de integración.
    ApiKeyModule,
  ],
  controllers: [IntegrationWebhookEndpointController],
  providers: [
    WebhookSecretCipherService,
    WebhookEndpointUrlPolicy,
    GetWebhookEndpointUseCase,
    UpsertWebhookEndpointUseCase,
    RotateWebhookSecretUseCase,
    DisableWebhookEndpointUseCase,
  ],
})
export class OutboundWebhooksModule {}
