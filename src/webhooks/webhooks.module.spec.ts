import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { getRepositoryToken } from '@nestjs/typeorm';
import { AccountEntity } from 'src/account/entities/account.entity';
import { AccountSubscriptionEntity } from 'src/payments/entities/account-subscription.entity';
import { WebhooksModule } from './webhooks.module';
import { WebhookEventEntity } from './entities/webhook-event.entity';
import { DiditWebhookController } from './didit-webhook.controller';
import { StripeWebhookController } from './stripe-webhook.controller';

/**
 * Vale la pena tenerlo: los errores de cableado de Nest (un provider que dejó de exportarse,
 * un import que falta) sólo aparecen al arrancar la aplicación contra Postgres y Mongo, así que
 * sin esta prueba se descubrirían en el despliegue. También fija que el módulo levanta **sin**
 * `DIDIT_VERIFICATION_PROCESSOR` atado, que es la situación actual del repositorio.
 */
describe('WebhooksModule', () => {
  it('resuelve el grafo de dependencias sin el procesador de Didit', async () => {
    const repositoryStub = {};

    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true }), WebhooksModule],
    })
      .overrideProvider(getRepositoryToken(WebhookEventEntity))
      .useValue(repositoryStub)
      .overrideProvider(getRepositoryToken(AccountSubscriptionEntity))
      .useValue(repositoryStub)
      .overrideProvider(getRepositoryToken(AccountEntity))
      .useValue(repositoryStub)
      .compile();

    expect(moduleRef.get(DiditWebhookController)).toBeDefined();
    expect(moduleRef.get(StripeWebhookController)).toBeDefined();
  });
});
