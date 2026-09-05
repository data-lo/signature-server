import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BillingModule } from 'src/billing/billing.module';
import { AccountSubscriptionEntity } from './entities/account-subscription.entity';
import { StripePaymentService } from './stripe/stripe-payment.service';
import { StripeWebhookService } from './stripe/stripe-webhook.service';
import { GetPublicStripePlansUseCase } from './applications/get-public-stripe-plans.use-case';
import { GetSubscriptionStateUseCase } from './applications/get-subscription-state.use-case';
import { PaymentsController } from './payments.controller';
import { SharedModule } from 'src/shared/shared.module';

/**
 * Dominio de pagos: catálogo de servicios, compra y estado de la suscripción.
 *
 * Sustituye al antiguo `StripeModule`. El cambio no es sólo de nombre: Stripe pasa de dar
 * nombre al módulo a ser un proveedor dentro de él (`payments/stripe`), y toda la orquestación
 * baja a casos de uso en `applications/`. El único archivo que conoce el SDK del proveedor es
 * `StripePaymentService`, así que un segundo proveedor se agrega al lado sin tocar los
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
    /**
     * `AccountEntity` ya no se registra acá: entró cuando `GetSubscriptionStateUseCase`
     * resolvía la cuenta por su cuenta, y desde que esa resolución la hace `BillingOwnerService`
     * ningún proveedor de este módulo inyecta ese repositorio. `AccountSubscriptionEntity` sí
     * sigue: `StripeWebhookService` mantiene esa tabla por compatibilidad, aunque ya no sea la
     * fuente de verdad del estado de suscripción.
     */
    TypeOrmModule.forFeature([AccountSubscriptionEntity]),
    // `forwardRef`: billing necesita el adaptador de Stripe de este módulo para abrir el
    // checkout, y este módulo necesita los handlers de billing en su router de webhooks.
    forwardRef(() => BillingModule),
    // `SharedModule` por `RedisService`: el catálogo público se cachea 10 minutos.
    SharedModule,
  ],
  controllers: [PaymentsController],
  providers: [
    StripePaymentService,
    StripeWebhookService,
    GetPublicStripePlansUseCase,
    GetSubscriptionStateUseCase,
  ],
  exports: [StripePaymentService, StripeWebhookService],
})
export class PaymentsModule {}
