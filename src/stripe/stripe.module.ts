import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AccountSubscriptionEntity } from './entities/account-subscription.entity';
import { AccountMemberEntity } from 'src/account/entities/account-member.entity';
import { StripeService } from './stripe.service';
import { StripeWebhookService } from './stripe-webhook.service';
import { StripeSignatureGuard } from './guards/stripe-signature.guard';
import { StripeCheckoutController } from './stripe-checkout.controller';
import { StripeWebhookController } from './stripe-webhook.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([AccountSubscriptionEntity, AccountMemberEntity]),
  ],
  controllers: [StripeCheckoutController, StripeWebhookController],
  providers: [StripeService, StripeWebhookService, StripeSignatureGuard],
  exports: [StripeService],
})
export class StripeModule {}
