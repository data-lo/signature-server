import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AccountEntity } from 'src/account/entities/account.entity';
import { AccountSubscriptionEntity } from './entities/account-subscription.entity';
import { StripePaymentGatewayService } from './stripe/stripe-payment-gateway.service';
import { StripeWebhookService } from './stripe/stripe-webhook.service';
import { StripeSignatureGuard } from './stripe/stripe-signature.guard';
import { GetPaymentServicesUseCase } from './applications/get-payment-services.use-case';
import { CreateStripeCheckoutSessionUseCase } from './applications/create-stripe-checkout-session.use-case';
import { GetSubscriptionStateUseCase } from './applications/get-subscription-state.use-case';
import { PaymentsController } from './payments.controller';
import { StripeWebhookController } from './stripe-webhook.controller';

/**
 * Dominio de pagos: catálogo de servicios, compra y estado de la suscripción.
 *
 * Sustituye al antiguo `StripeModule`. El cambio no es sólo de nombre: Stripe pasa de dar
 * nombre al módulo a ser un proveedor dentro de él (`payments/stripe`), y toda la orquestación
 * baja a casos de uso en `applications/`. El único archivo que conoce el SDK del proveedor es
 * `StripePaymentGatewayService`, así que un segundo proveedor se agrega al lado sin tocar los
 * casos de uso.
 *
 * `StripeWebhookService` y su controller siguen aquí por ahora. Cuando el módulo central
 * `webhooks` esté en esta rama, la recepción y la validación de firma se mudan allá y este
 * módulo se queda sólo con el efecto de dominio —activar o cancelar la suscripción—, invocado
 * como puerto. Ver la nota en `stripe-webhook.controller.ts`.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([AccountSubscriptionEntity, AccountEntity]),
  ],
  controllers: [PaymentsController, StripeWebhookController],
  providers: [
    StripePaymentGatewayService,
    StripeWebhookService,
    StripeSignatureGuard,
    GetPaymentServicesUseCase,
    CreateStripeCheckoutSessionUseCase,
    GetSubscriptionStateUseCase,
  ],
  exports: [StripePaymentGatewayService, StripeWebhookService],
})
export class PaymentsModule {}
