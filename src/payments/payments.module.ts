import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AccountEntity } from 'src/account/entities/account.entity';
import { BillingModule } from 'src/billing/billing.module';
import { AccountSubscriptionEntity } from './entities/account-subscription.entity';
import { StripePaymentGatewayService } from './stripe/stripe-payment-gateway.service';
import { StripeWebhookService } from './stripe/stripe-webhook.service';
import { GetPaymentServicesUseCase } from './applications/get-payment-services.use-case';
import { CreateStripeCheckoutSessionUseCase } from './applications/create-stripe-checkout-session.use-case';
import { GetSubscriptionStateUseCase } from './applications/get-subscription-state.use-case';
import { PaymentsController } from './payments.controller';

/**
 * Dominio de pagos: catálogo de servicios, compra y estado de la suscripción.
 *
 * Sustituye al antiguo `StripeModule`. El cambio no es sólo de nombre: Stripe pasa de dar
 * nombre al módulo a ser un proveedor dentro de él (`payments/stripe`), y toda la orquestación
 * baja a casos de uso en `applications/`. El único archivo que conoce el SDK del proveedor es
 * `StripePaymentGatewayService`, así que un segundo proveedor se agrega al lado sin tocar los
 * casos de uso.
 *
 * La recepción del webhook ya NO vive aquí: el módulo central `webhooks` recibe la entrega en
 * `POST /api/v1/webhooks/stripe`, verifica la firma sobre el cuerpo crudo y registra el evento
 * de forma idempotente en `webhook_events`. De este módulo sobrevive `StripeWebhookService`
 * como efecto de dominio —activar o cancelar la suscripción—, que `ReceiveStripeWebhookUseCase`
 * invoca con el evento ya autenticado; por eso se exporta junto con el gateway, cuyo `client`
 * usa `webhooks` para verificar la firma con la misma configuración de Stripe.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([AccountSubscriptionEntity, AccountEntity]),
    BillingModule,
  ],
  controllers: [PaymentsController],
  providers: [
    StripePaymentGatewayService,
    StripeWebhookService,
    GetPaymentServicesUseCase,
    CreateStripeCheckoutSessionUseCase,
    GetSubscriptionStateUseCase,
  ],
  exports: [StripePaymentGatewayService, StripeWebhookService],
})
export class PaymentsModule {}
