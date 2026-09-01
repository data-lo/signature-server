import { setTestModuleGraphEnv } from 'src/shared/testing/module-graph-env';
import { Global, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm';
import { AccountEntity } from 'src/account/entities/account.entity';
import { AccountSubscriptionEntity } from 'src/payments/entities/account-subscription.entity';
import { IdentityVerificationEntity } from 'src/identity-verification/entities/identity-verification.entity';
import { UserEntity } from 'src/user/entities/user.entity';
import { RedisService } from 'src/shared/redis/redis.service';
import { PlanEntity } from 'src/billing/catalog/plan.entity';
import { PlanPriceEntity } from 'src/billing/catalog/plan-price.entity';
import { DocumentPackOfferEntity } from 'src/billing/catalog/document-pack-offer.entity';
import { BillingProfileEntity } from 'src/billing/profiles/billing-profile.entity';
import { CheckoutOrderEntity } from 'src/billing/checkout/checkout-order.entity';
import { CreditLotEntity } from 'src/billing/credits/credit-lot.entity';
import { DocumentCreditConsumptionEntity } from 'src/billing/credits/document-credit-consumption.entity';
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
beforeAll(() => {
  setTestModuleGraphEnv();
});

/**
 * `overrideProvider` sólo puede sustituir un provider que YA exista, y aquí no hay ningún
 * `TypeOrmModule.forRoot()` que aporte el `DataSource` que `SubscriptionBillingService` inyecta
 * para la transacción de `invoice.paid`. Un módulo global de prueba sí lo introduce en todos los
 * contextos, incluido el de `BillingModule`.
 */
@Global()
@Module({
  providers: [
    { provide: getDataSourceToken(), useValue: { transaction: jest.fn() } },
  ],
  exports: [getDataSourceToken()],
})
class StubDataSourceModule {}

describe('WebhooksModule', () => {
  it('resuelve el grafo de dependencias, incluido el procesador de Didit', async () => {
    const repositoryStub = {};

    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        StubDataSourceModule,
        WebhooksModule,
      ],
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
      .overrideProvider(getRepositoryToken(PlanEntity))
      .useValue(repositoryStub)
      .overrideProvider(getRepositoryToken(PlanPriceEntity))
      .useValue(repositoryStub)
      .overrideProvider(getRepositoryToken(DocumentPackOfferEntity))
      .useValue(repositoryStub)
      .overrideProvider(getRepositoryToken(BillingProfileEntity))
      .useValue(repositoryStub)
      .overrideProvider(getRepositoryToken(CheckoutOrderEntity))
      .useValue(repositoryStub)
      .overrideProvider(getRepositoryToken(CreditLotEntity))
      .useValue(repositoryStub)
      .overrideProvider(getRepositoryToken(DocumentCreditConsumptionEntity))
      .useValue(repositoryStub)
      .overrideProvider(RedisService)
      .useValue({ del: jest.fn() })
      .compile();

    expect(moduleRef.get(DiditWebhookController)).toBeDefined();
    expect(moduleRef.get(StripeWebhookController)).toBeDefined();
    expect(moduleRef.get(ReceiveDiditWebhookUseCase)).toBeDefined();
  });
});
