import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { WebhookDeliveryAttemptEntity } from './entities/webhook-delivery-attempt.entity';
import { WebhookDeliveryEntity } from './entities/webhook-delivery.entity';
import { WebhookEndpointEntity } from './entities/webhook-endpoint.entity';
import { WebhookSecretVersionEntity } from './entities/webhook-secret-version.entity';

/**
 * Webhooks salientes: notifica a los sistemas de los clientes los eventos de firma de sus
 * documentos. Distinto de `WebhooksModule`, que recibe los webhooks entrantes de Stripe, Didit y el
 * indexador.
 *
 * Por ahora sólo registra el modelo de datos; los casos de uso, servicios, worker y controladores
 * están descritos en `README.md` y llegan en las siguientes tareas.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      WebhookEndpointEntity,
      WebhookSecretVersionEntity,
      WebhookDeliveryEntity,
      WebhookDeliveryAttemptEntity,
    ]),
  ],
})
export class OutboundWebhooksModule {}
