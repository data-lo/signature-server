import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { getRepositoryToken } from '@nestjs/typeorm';
import { AccountEntity } from 'src/account/entities/account.entity';
import { AccountSubscriptionEntity } from 'src/payments/entities/account-subscription.entity';
import { IdentityVerificationEntity } from 'src/identity-verification/entities/identity-verification.entity';
import { UserEntity } from 'src/user/entities/user.entity';
import { RedisService } from 'src/shared/redis/redis.service';
import { WebhooksModule } from './webhooks.module';
import { WebhookEventEntity } from './entities/webhook-event.entity';
import { ReceiveDiditWebhookUseCase } from './applications/receive-didit-webhook.use-case';
import { DiditWebhookController } from './didit-webhook.controller';
import { StripeWebhookController } from './stripe-webhook.controller';

/**
 * Vale la pena tenerlo: los errores de cableado de Nest (un provider que dejó de exportarse,
 * un import que falta) sólo aparecen al arrancar la aplicación contra Postgres y Mongo, así que
 * sin esta prueba se descubrirían en el despliegue. Fija además que la recepción de Didit
 * resuelve `ProcessDiditVerificationResultUseCase` de verdad: si `IdentityVerificationModule`
 * dejara de importarse o de exportarlo, el grafo no compilaría acá y no en producción.
 */
describe('WebhooksModule', () => {
  it('resuelve el grafo de dependencias, incluido el procesador de Didit', async () => {
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
      .overrideProvider(getRepositoryToken(IdentityVerificationEntity))
      .useValue(repositoryStub)
      .overrideProvider(getRepositoryToken(UserEntity))
      .useValue(repositoryStub)
      .overrideProvider(RedisService)
      .useValue({ del: jest.fn() })
      .compile();

    expect(moduleRef.get(DiditWebhookController)).toBeDefined();
    expect(moduleRef.get(StripeWebhookController)).toBeDefined();
    expect(moduleRef.get(ReceiveDiditWebhookUseCase)).toBeDefined();
  });
});
