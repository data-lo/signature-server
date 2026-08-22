import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AccountSubscriptionEntity } from './entities/account-subscription.entity';
import { AccountEntity } from 'src/account/entities/account.entity';
import { StripeService } from './stripe.service';
import { StripeWebhookService } from './stripe-webhook.service';
import { StripeCheckoutController } from './stripe-checkout.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([AccountSubscriptionEntity, AccountEntity]),
  ],
  controllers: [StripeCheckoutController],
  providers: [StripeService, StripeWebhookService],
  /**
   * `StripeWebhookService` se exporta para `WebhooksModule`, que es quien ahora recibe la
   * entrega HTTP (`POST /api/v1/webhooks/stripe`), verifica la firma y le delega el evento ya
   * autenticado. Las reglas de suscripción siguen viviendo acá.
   */
  exports: [StripeService, StripeWebhookService],
})
export class StripeModule {}
