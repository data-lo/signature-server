import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PaymentsModule } from 'src/payments/payments.module';
import { IdentityVerificationModule } from 'src/identity-verification/identity-verification.module';
import { WebhookEventEntity } from './entities/webhook-event.entity';
import { DiditWebhookSignatureVerifierService } from './didit/didit-webhook-signature-verifier.service';
import { StripeWebhookSignatureVerifierService } from './stripe/stripe-webhook-signature-verifier.service';
import { RegisterWebhookEventUseCase } from './applications/register-webhook-event.use-case';
import { ReceiveDiditWebhookUseCase } from './applications/receive-didit-webhook.use-case';
import { ReceiveStripeWebhookUseCase } from './applications/receive-stripe-webhook.use-case';
import { DiditWebhookController } from './didit-webhook.controller';
import { StripeWebhookController } from './stripe-webhook.controller';

/**
 * Punto de entrada único de los webhooks de proveedores externos: recibe el cuerpo crudo, verifica
 * la firma del proveedor, registra la entrega de forma idempotente en `webhook_events` y delega al
 * caso de uso del dominio correspondiente.
 *
 * Acá no hay una sola regla sobre cuándo se aprueba una identidad o cómo cambia una suscripción; eso
 * vive en `identity-verification` y en `payments`.
 *
 * Importa `PaymentsModule` por dos piezas del dominio de pagos: `StripePaymentService` —el cliente ya
 * configurado con el que se verifica la firma— y `StripeWebhookService`, el destinatario de la
 * delegación. Importa `IdentityVerificationModule` por `ProcessDiditVerificationResultUseCase`, que
 * interpreta el resultado de una sesión de Didit y mueve el estado del usuario.
 *
 * Las dos dependencias van en un solo sentido: ni `payments` ni `identity-verification` conocen a
 * `webhooks`, y ninguno tiene controller de webhooks ni verificación de firma, por diseño.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([WebhookEventEntity]),
    PaymentsModule,
    IdentityVerificationModule,
  ],
  controllers: [DiditWebhookController, StripeWebhookController],
  providers: [
    DiditWebhookSignatureVerifierService,
    StripeWebhookSignatureVerifierService,
    RegisterWebhookEventUseCase,
    ReceiveDiditWebhookUseCase,
    ReceiveStripeWebhookUseCase,
  ],
  exports: [RegisterWebhookEventUseCase],
})
export class WebhooksModule {}
